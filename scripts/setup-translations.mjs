#!/usr/bin/env node
/** Explicit model setup. The running dashboard never downloads models or sends
 * instruction text outside the machine. Versions and weight hashes are pinned. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const destination = resolve(
  process.argv[2] ??
    process.env.MIRANTE_TRANSLATION_MODEL_DIR ??
    join(process.env.MIRANTE_HOME ?? join(homedir(), '.mirante'), 'translations/models'),
);
const models = [
  { name: 'Xenova/opus-mt-en-ROMANCE', revision: '9d2ba69ac80c8e8453c3d9a1e2323a0e7b8ca3cd' },
  { name: 'Xenova/opus-mt-ROMANCE-en', revision: 'f60feaabe8bb435a5871e7702b25f53a01e770f8' },
];
const files = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'README.md',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

const download = (address, redirects = 0) =>
  new Promise((done, fail) => {
    const url = new URL(address);
    if (
      url.protocol !== 'https:' ||
      !/^(huggingface\.co|[^/]+\.(huggingface\.co|hf\.co))$/.test(url.hostname) ||
      redirects > 8
    )
      return fail(new Error('Unexpected model download destination.'));
    const request = get(
      url,
      { headers: { 'user-agent': 'mirante-local-translation-setup' } },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          return download(new URL(response.headers.location, url).href, redirects + 1).then(
            done,
            fail,
          );
        }
        if (response.statusCode !== 200) {
          response.resume();
          return fail(new Error(`Model download failed (${response.statusCode}).`));
        }
        done(response);
      },
    );
    request.setTimeout(60_000, () => request.destroy(new Error('Model download timed out.')));
    request.on('error', fail);
  });

const sha256 = async (path) => {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest('hex');
};

await mkdir(destination, { recursive: true });
const installed = [];
for (const model of models) {
  const response = await download(
    `https://huggingface.co/api/models/${model.name}/revision/${model.revision}?blobs=true`,
  );
  let json = '';
  for await (const block of response) json += block;
  const metadata = JSON.parse(json);
  if (metadata.sha !== model.revision) throw new Error('Model revision mismatch.');
  const hashes = {};
  for (const file of files) {
    const path = join(destination, model.name, file);
    const entry = metadata.siblings.find((candidate) => candidate.rfilename === file);
    if (!entry) throw new Error(`Missing model file: ${file}`);
    const expectedHash = entry.lfs?.sha256;
    if (existsSync(path) && expectedHash && (await sha256(path)) === expectedHash) {
      hashes[file] = expectedHash;
      console.log(`Verified ${model.name}/${file}`);
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    try {
      await pipeline(
        await download(`https://huggingface.co/${model.name}/resolve/${model.revision}/${file}`),
        createWriteStream(partial),
      );
      const actualHash = await sha256(partial);
      if (expectedHash && actualHash !== expectedHash)
        throw new Error(`Model checksum mismatch: ${file}`);
      // JSON is parsed before replacing a previously installed file.
      if (file.endsWith('.json')) JSON.parse(await readFile(partial, 'utf8'));
      await rename(partial, path);
      hashes[file] = actualHash;
      console.log(`Installed ${model.name}/${file}`);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
  installed.push({ ...model, hashes });
}
await writeFile(
  join(destination, 'manifest.json'),
  `${JSON.stringify({ models: installed }, null, 2)}\n`,
);
console.log(`Local EN/PT translation models ready in ${destination}`);
