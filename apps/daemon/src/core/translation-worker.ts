import { parentPort, workerData } from 'node:worker_threads';
import { resolve, sep } from 'node:path';
import { env, pipeline, type TranslationPipeline } from '@huggingface/transformers';

// The setup command installs pinned files. Inference can only read those files;
// it never downloads a model or sends instruction text outside this process.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = resolve(workerData.modelDir as string) + sep;
env.useBrowserCache = false;
env.useFSCache = false;
globalThis.fetch = async () => {
  throw new Error('Network disabled');
};
const models = { pt: 'Xenova/opus-mt-en-ROMANCE', en: 'Xenova/opus-mt-ROMANCE-en' } as const;
const translators = new Map<string, TranslationPipeline>();

parentPort?.on('message', async (request: { texts: string[]; target: 'pt' | 'en' }) => {
  try {
    if (!(request.target in models)) throw new Error('Invalid target');
    let translator = translators.get(request.target);
    if (!translator) {
      translator = await pipeline('translation', models[request.target], {
        local_files_only: true,
        dtype: 'q8',
        device: 'cpu',
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      });
      translators.set(request.target, translator);
    }
    const texts: string[] = [];
    // Small sequential inputs bound model memory even for a 64K instruction.
    for (const text of request.texts) {
      const input = request.target === 'pt' ? `>>pt<< ${text}` : text;
      // Transformers accepts partial generation options at runtime, but its
      // 3.8 declarations incorrectly require every defaulted field.
      const output = await translator(input, {
        max_new_tokens: 256,
        num_beams: 1,
        do_sample: false,
      } as Parameters<TranslationPipeline>[1]);
      const result = output[0];
      if (!result || !('translation_text' in result)) throw new Error('Invalid result');
      texts.push(result.translation_text);
    }
    parentPort?.postMessage({ ok: true, texts });
  } catch {
    parentPort?.postMessage({ ok: false });
  }
});
