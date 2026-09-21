import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const LOCALES = ['en', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABEL: Record<Locale, string> = { en: 'EN', 'pt-BR': 'PT' };

type Vars = Record<string, string | number>;

const en = {
  'brand.tagline': 'Local lookout for coding agents',

  'theme.auto': 'Auto',
  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'theme.label': 'Theme',
  'lang.label': 'Language',

  'conn.connecting': 'Connecting',
  'conn.live': 'Live',
  'conn.offline': 'Daemon offline',
  'conn.unauthorized': 'Token rejected',

  'stat.sessions': 'Sessions',
  'stat.sessions.hint': '{count} total',
  'stat.agents': 'Agents',
  'stat.agents.hint': 'still working',
  'stat.tokens': 'Tokens',
  'stat.cost': 'Cost',
  'stat.allSessions': 'all sessions',

  'plan.fiveHour': '5-hour limit',
  'plan.weekly': 'Weekly limit',
  'plan.spend': 'Spend limit',
  'plan.unknown': 'unknown',
  'plan.asOf': 'as of {ago}',
  'plan.ago.justNow': 'just now',
  'plan.ago.minutes': '{n}m ago',
  'plan.ago.hours': '{n}h ago',
  'plan.hint.needsPlan': 'needs Pro or Max, after one reply',
  'plan.resetting': 'resetting',
  'plan.resetsInMinutes': 'resets in {n}m',
  'plan.resetsInHours': 'resets in {n}h',
  'plan.resetsOn': 'resets {date}',

  'filter.project': 'Project',
  'filter.allProjects': 'All projects',
  'filter.hideFinished': 'Hide finished',
  'project.state.needs_you': 'waiting on you',
  'project.state.working': 'working',
  'project.state.blocked': 'at the limit',
  'project.state.idle': 'idle',
  'project.state.finished': 'finished',
  'project.archive': 'Archive',
  'project.archiveTitle': 'Hide this project from the board. Nothing is deleted.',
  'project.restoreAll': 'Restore {n} archived',
  'project.restoreOne': 'Restore 1 archived',
  'filter.hideOld': 'Hide old',
  'filter.hideOldCount': 'Hide old ({n})',
  'filter.hideOldTitle':
    'Sessions with no signal for more than 3 days. They come back by themselves when they do something.',
  'old.emptyTitle': 'Nothing in the last 3 days',
  'old.emptyBody':
    '{n} older sessions are hidden. They come back by themselves when they do something.',
  'old.show': 'Show old sessions',
  'latest.followedByOne': 'Followed by “{text}”',
  'latest.followedByMany': 'Followed by {n} short replies, the last “{text}”',
  'latest.includesOne': 'Includes the reply after it',
  'latest.includesMany': 'Includes the {n} replies after it',
  'error.api': 'API error',
  'error.tool': 'Tool failed',
  'error.parse': 'Unreadable entry',
  'error.parseTitle': 'Mirante could not read this part of the transcript.',
  'error.internal': 'Internal error',
  'stopped.reopensAtLower': 'reopens at {time}',
  'stopped.reopenedAt': 'reopened at {time}',
  'turn.steps': '{n} steps',
  'turn.stepsOne': '1 step',
  'turn.noPrompt': 'Prompt not captured',
  'turn.fromAgent': 'A subagent reported back',
  'turn.fromSystem': 'Opened by Claude Code',
  'activity.brief': 'brief',
  'project.sessions': '{n} sessions',
  'project.sessions.one': '1 session',
  'project.allArchived': 'Every project is archived',
  'project.allArchivedBody': 'Restore them to see the board again.',

  'state.idle': 'Idle',
  'state.thinking': 'Thinking',
  'state.tool_running': 'Running',
  'state.waiting_approval': 'Needs approval',
  'state.waiting_input': 'Waiting for you',
  'state.waiting_subagent': 'Waiting on agent',
  'state.rate_limited': 'Rate limited',
  'state.done': 'Done',
  'state.error': 'Error',

  'waiting.subagent': 'Waiting on {subject}',
  'waiting.approval': 'Approve {subject}',
  'waiting.input': 'Claude is waiting for you',
  'waiting.plan_limit.fiveHour': 'At the 5-hour limit',
  'waiting.plan_limit.sevenDay': 'At the weekly limit',
  'waiting.plan_limit.spendLimit': 'At the spend limit',
  'waiting.for': 'waiting {duration}',

  'role.session': 'the window you type into',
  'role.general': 'general-purpose worker, for open-ended tasks',
  'role.explore': 'read-only search across the codebase',
  'role.plan': 'designs an approach before code is written',
  'role.setup': 'configures the status line',
  'role.guide': 'answers questions about Claude Code',
  'role.custom': 'custom agent from .claude/agents',
  'role.unknown': 'started before Mirante was watching',

  'agentRole.analyst': 'Analyst',
  'agentRole.dev': 'Dev',
  'agentRole.qa': 'QA',
  'agentRole.docs': 'Docs',
  'agentRole.designer': 'Designer',
  'agentRole.architect': 'Architect',
  'agentRole.explorer': 'Explorer',

  'card.session': 'Main',
  'card.subagent': 'subagent',
  'card.mainSession': 'main session',
  'card.lastAction': 'last action',
  'card.lastMessage': 'your last message',
  'card.agentsRunning': '{count} running',
  'card.subagents': '{count} subagents',
  'card.subagent.one': '1 subagent',
  'card.allow': 'Allow',
  'card.deny': 'Deny',
  'card.orTerminal': 'or the terminal will ask',
  'card.tokens': 'tok',

  'lane.openDetail': 'Open',
  'lane.ended': 'ended',
  'lane.context': 'ctx',

  'timeline.title': 'Timeline',
  'timeline.empty': 'Nothing yet. Start a session in your terminal or VS Code.',
  'timeline.all': 'All',
  'timeline.handoffs': 'Agents',
  'timeline.tools': 'Tools',
  'timeline.skills': 'Skills',
  'timeline.permissions': 'Permissions',
  'timeline.errors': 'Problems',
  'timeline.skill': 'Skill: {subject}',
  'timeline.compaction': 'Context compacted',
  'timeline.permissionNeeded': '{subject} needs approval',
  'timeline.permissionAllow': 'Allowed from the board',
  'timeline.permissionDeny': 'Denied from the board',
  'timeline.permissionFallback': 'Answered in the terminal',
  'timeline.repeated': '×{count}',

  'detail.back': 'Back to board',
  'detail.tab.agents': 'Agents',
  'detail.tab.activity': 'Activity',
  'detail.tab.requests': 'Requests',
  'detail.activity.empty': 'No activity recorded for this agent yet.',
  'detail.agents.empty': 'No subagents were spawned in this session.',
  'detail.requests.empty': 'No requests recorded yet.',
  'detail.allAgents': 'All agents',
  'activity.spawned': 'spawned',
  'activity.returned': 'returned',
  'detail.request': 'Request',
  'detail.request.noText': 'Request — its prompt was not captured',
  'detail.requestAt': 'sent {time}',
  'detail.agentsSpawned': 'Agents',
  'detail.toolsRun': 'Tools',
  'detail.duration': 'Duration',
  'detail.stillRunning': 'still running',
  'detail.toolsFailed': '{count} failed',
  'detail.planAtTime': 'Plan usage',
  'detail.planUnknown': 'not reported',

  'state.interrupted': 'Interrupted',
  'state.silent': 'No signal',
  'card.silentFor': 'Said it was working; nothing heard for {d}',
  'stopped.fiveHour': 'Stopped at the 5-hour limit',
  'stopped.sevenDay': 'Stopped at the weekly limit',
  'stopped.plan': 'Stopped at a plan limit',
  'stopped.reopensAt': 'Reopens at {time}',
  'stopped.reopened': 'The window has reopened; this can run again',
  'plan.limits': 'Plan limits',
  'plan.fiveHour.short': '5 hours',
  'plan.weekly.short': 'Week',
  'plan.atLimit': 'at limit',
  'plan.windowReset': 'window reset, read again',
  'plan.readAt': 'Read at {time}',
  'spend.unknown': 'cost unknown',
  'spend.partial': 'partial',
  'spend.tokens': '{n} tokens',
  'spend.label': 'Spend across sessions',
  'settings.label': 'Display settings',
  'settings.theme': 'Theme',
  'settings.language': 'Language',
  'project.waiting': '{n} waiting',
  'project.allSessions': 'All',
  'latest.for': 'for {d}',
  'latest.doneAgo': 'done {ago}',
  'latest.soFar': '{cost} so far',
  'latest.openSession': 'Open this session',
  'plan.refresh': 'Read now',
  'plan.refreshing': 'Reading',
  'plan.refreshTitle':
    "Updates by itself every minute while an agent is working. Read now runs Claude Code's /usage and spends no tokens.",
  'plan.refreshTitleAt':
    "Updates by itself every minute while an agent is working. Figure from {time}. Read now runs Claude Code's /usage and spends no tokens.",
  'plan.lastUsed': 'last used {d} ago',
  'plan.noReading': 'no reading yet',
  'plan.hint.notRead': 'not read yet',
  'plan.error.claude-not-found': 'claude is not on PATH',
  'plan.error.command-failed': 'the command did not finish',
  'plan.error.unexpected-output': 'Claude Code answered in a form Mirante does not know',
  'plan.error.no-plan-data': 'this account reports no plan limits',
  'plan.error.unreachable': 'the daemon did not answer',
  'plan.error.not-local':
    'Claude Code answered /usage with the model, which costs tokens; automatic reading stopped',

  'latest.title': 'Latest request',
  'latest.in': 'in {project}',
  'latest.none': 'No request captured yet.',

  'empty.title': 'No sessions yet',
  'empty.body': 'Open Claude Code in your terminal or in VS Code. The board fills itself.',
  'empty.unauthorized.title': 'This page has no valid token',
  'empty.unauthorized.body': 'Open the URL that `mirante` printed — it carries the token.',

  'entry.cli': 'terminal',
  'entry.vscode': 'VS Code',
  'entry.sdk': 'SDK',
  'entry.print': 'claude -p',
  'entry.unknown': '',
} as const;

type Key = keyof typeof en;

const ptBR: Record<Key, string> = {
  'brand.tagline': 'Mirante local para agentes de código',

  'theme.auto': 'Auto',
  'theme.dark': 'Escuro',
  'theme.light': 'Claro',
  'theme.label': 'Tema',
  'lang.label': 'Idioma',

  'conn.connecting': 'Conectando',
  'conn.live': 'Ao vivo',
  'conn.offline': 'Daemon desligado',
  'conn.unauthorized': 'Token recusado',

  'stat.sessions': 'Sessões',
  'stat.sessions.hint': '{count} no total',
  'stat.agents': 'Agentes',
  'stat.agents.hint': 'ainda trabalhando',
  'stat.tokens': 'Tokens',
  'stat.cost': 'Custo',
  'stat.allSessions': 'todas as sessões',

  'plan.fiveHour': 'Limite de 5 horas',
  'plan.weekly': 'Limite semanal',
  'plan.spend': 'Limite de gasto',
  'plan.unknown': 'desconhecido',
  'plan.asOf': 'de {ago}',
  'plan.ago.justNow': 'agora',
  'plan.ago.minutes': '{n}min atrás',
  'plan.ago.hours': '{n}h atrás',
  'plan.hint.needsPlan': 'precisa de Pro ou Max, após a primeira resposta',
  'plan.resetting': 'reiniciando',
  'plan.resetsInMinutes': 'reinicia em {n}min',
  'plan.resetsInHours': 'reinicia em {n}h',
  'plan.resetsOn': 'reinicia {date}',

  'filter.project': 'Projeto',
  'filter.allProjects': 'Todos os projetos',
  'filter.hideFinished': 'Ocultar encerradas',
  'project.state.needs_you': 'esperando você',
  'project.state.working': 'trabalhando',
  'project.state.blocked': 'no limite',
  'project.state.idle': 'parado',
  'project.state.finished': 'encerrado',
  'project.archive': 'Arquivar',
  'project.archiveTitle': 'Esconde este projeto do painel. Nada é apagado.',
  'project.restoreAll': 'Restaurar {n} arquivados',
  'project.restoreOne': 'Restaurar 1 arquivado',
  'filter.hideOld': 'Ocultar antigas',
  'filter.hideOldCount': 'Ocultar antigas ({n})',
  'filter.hideOldTitle':
    'Sessões sem sinal há mais de 3 dias. Voltam sozinhas quando tiverem atividade.',
  'old.emptyTitle': 'Nada nos últimos 3 dias',
  'old.emptyBody': '{n} sessões antigas estão ocultas. Voltam sozinhas quando tiverem atividade.',
  'old.show': 'Mostrar antigas',
  'latest.followedByOne': 'Seguida de “{text}”',
  'latest.followedByMany': 'Seguida de {n} respostas curtas, a última “{text}”',
  'latest.includesOne': 'Inclui a resposta seguinte',
  'latest.includesMany': 'Inclui as {n} respostas seguintes',
  'error.api': 'Erro na API',
  'error.tool': 'Ferramenta falhou',
  'error.parse': 'Registro ilegível',
  'error.parseTitle': 'O Mirante não conseguiu ler este trecho da transcrição.',
  'error.internal': 'Erro interno',
  'stopped.reopensAtLower': 'volta às {time}',
  'stopped.reopenedAt': 'reabriu às {time}',
  'turn.steps': '{n} passos',
  'turn.stepsOne': '1 passo',
  'turn.noPrompt': 'Texto não capturado',
  'turn.fromAgent': 'Retorno de um subagente',
  'turn.fromSystem': 'Aberto pelo Claude Code',
  'activity.brief': 'instrução',
  'project.sessions': '{n} sessões',
  'project.sessions.one': '1 sessão',
  'project.allArchived': 'Todos os projetos estão arquivados',
  'project.allArchivedBody': 'Restaure para ver o painel de novo.',

  'state.idle': 'Ocioso',
  'state.thinking': 'Pensando',
  'state.tool_running': 'Executando',
  'state.waiting_approval': 'Aguarda aprovação',
  'state.waiting_input': 'Esperando você',
  'state.waiting_subagent': 'Aguarda agente',
  'state.rate_limited': 'No limite',
  'state.done': 'Concluído',
  'state.error': 'Erro',

  'waiting.subagent': 'Aguardando {subject}',
  'waiting.approval': 'Aprovar {subject}',
  'waiting.input': 'O Claude está esperando você',
  'waiting.plan_limit.fiveHour': 'No limite de 5 horas',
  'waiting.plan_limit.sevenDay': 'No limite semanal',
  'waiting.plan_limit.spendLimit': 'No limite de gasto',
  'waiting.for': 'esperando há {duration}',

  'role.session': 'a janela onde você digita',
  'role.general': 'agente de uso geral, para tarefas abertas',
  'role.explore': 'busca somente leitura pelo código',
  'role.plan': 'desenha a abordagem antes de escrever código',
  'role.setup': 'configura a status line',
  'role.guide': 'responde dúvidas sobre o Claude Code',
  'role.custom': 'agente próprio, de .claude/agents',
  'role.unknown': 'começou antes do Mirante estar observando',

  'agentRole.analyst': 'Analista',
  'agentRole.dev': 'Dev',
  'agentRole.qa': 'QA',
  'agentRole.docs': 'Docs',
  'agentRole.designer': 'Designer',
  'agentRole.architect': 'Arquiteto',
  'agentRole.explorer': 'Explorador',

  'card.session': 'Principal',
  'card.subagent': 'subagente',
  'card.mainSession': 'sessão principal',
  'card.lastAction': 'última ação',
  'card.lastMessage': 'sua última mensagem',
  'card.agentsRunning': '{count} rodando',
  'card.subagents': '{count} subagentes',
  'card.subagent.one': '1 subagente',
  'card.allow': 'Permitir',
  'card.deny': 'Negar',
  'card.orTerminal': 'ou o terminal vai perguntar',
  'card.tokens': 'tok',

  'lane.openDetail': 'Abrir',
  'lane.ended': 'encerrada',
  'lane.context': 'ctx',

  'timeline.title': 'Linha do tempo',
  'timeline.empty': 'Nada ainda. Abra uma sessão no terminal ou no VS Code.',
  'timeline.all': 'Tudo',
  'timeline.handoffs': 'Agentes',
  'timeline.tools': 'Ferramentas',
  'timeline.skills': 'Skills',
  'timeline.permissions': 'Permissões',
  'timeline.errors': 'Problemas',
  'timeline.skill': 'Skill: {subject}',
  'timeline.compaction': 'Contexto compactado',
  'timeline.permissionNeeded': '{subject} precisa de aprovação',
  'timeline.permissionAllow': 'Permitido pelo painel',
  'timeline.permissionDeny': 'Negado pelo painel',
  'timeline.permissionFallback': 'Respondido no terminal',
  'timeline.repeated': '×{count}',

  'detail.back': 'Voltar ao painel',
  'detail.tab.agents': 'Agentes',
  'detail.tab.activity': 'Atividade',
  'detail.tab.requests': 'Solicitações',
  'detail.activity.empty': 'Nenhuma atividade registrada para este agente ainda.',
  'detail.agents.empty': 'Nenhum subagente foi criado nesta sessão.',
  'detail.requests.empty': 'Nenhuma solicitação registrada ainda.',
  'detail.allAgents': 'Todos os agentes',
  'activity.spawned': 'iniciou',
  'activity.returned': 'retornou',
  'detail.request': 'Solicitação',
  'detail.request.noText': 'Solicitação — o texto dela não foi capturado',
  'detail.requestAt': 'enviada {time}',
  'detail.agentsSpawned': 'Agentes',
  'detail.toolsRun': 'Ferramentas',
  'detail.duration': 'Duração',
  'detail.stillRunning': 'ainda rodando',
  'detail.toolsFailed': '{count} falharam',
  'detail.planAtTime': 'Uso do plano',
  'detail.planUnknown': 'não reportado',

  'state.interrupted': 'Interrompido',
  'state.silent': 'Sem sinal',
  'card.silentFor': 'Dizia estar trabalhando; nenhum sinal há {d}',
  'stopped.fiveHour': 'Parou no limite de 5 horas',
  'stopped.sevenDay': 'Parou no limite semanal',
  'stopped.plan': 'Parou num limite do plano',
  'stopped.reopensAt': 'Volta às {time}',
  'stopped.reopened': 'A janela já reabriu; dá para rodar de novo',
  'plan.limits': 'Limites do plano',
  'plan.fiveHour.short': '5 horas',
  'plan.weekly.short': 'Semana',
  'plan.atLimit': 'no limite',
  'plan.windowReset': 'janela reiniciou, leia de novo',
  'plan.readAt': 'Lido às {time}',
  'spend.unknown': 'custo desconhecido',
  'spend.partial': 'parcial',
  'spend.tokens': '{n} tokens',
  'spend.label': 'Gasto somando as sessões',
  'settings.label': 'Ajustes de exibição',
  'settings.theme': 'Tema',
  'settings.language': 'Idioma',
  'project.waiting': '{n} esperando',
  'project.allSessions': 'Todos',
  'latest.for': 'há {d}',
  'latest.doneAgo': 'concluída {ago}',
  'latest.soFar': '{cost} até agora',
  'latest.openSession': 'Abrir esta sessão',
  'plan.refresh': 'Ler agora',
  'plan.refreshing': 'Lendo',
  'plan.refreshTitle':
    'Atualiza sozinho a cada minuto enquanto algum agente trabalha. Ler agora roda o /usage do Claude Code e não gasta tokens.',
  'plan.refreshTitleAt':
    'Atualiza sozinho a cada minuto enquanto algum agente trabalha. Número de {time}. Ler agora roda o /usage do Claude Code e não gasta tokens.',
  'plan.lastUsed': 'último uso há {d}',
  'plan.noReading': 'sem leitura ainda',
  'plan.hint.notRead': 'ainda não consultado',
  'plan.error.claude-not-found': 'claude não está no PATH',
  'plan.error.command-failed': 'o comando não terminou',
  'plan.error.unexpected-output': 'o Claude Code respondeu num formato que o Mirante não conhece',
  'plan.error.no-plan-data': 'esta conta não reporta limites de plano',
  'plan.error.unreachable': 'o daemon não respondeu',
  'plan.error.not-local':
    'o Claude Code respondeu o /usage com o modelo, o que gasta tokens; leitura automática parada',

  'latest.title': 'Última solicitação',
  'latest.in': 'em {project}',
  'latest.none': 'Nenhuma solicitação capturada ainda.',

  'empty.title': 'Nenhuma sessão ainda',
  'empty.body': 'Abra o Claude Code no terminal ou no VS Code. O painel se preenche sozinho.',
  'empty.unauthorized.title': 'Esta página não tem um token válido',
  'empty.unauthorized.body': 'Abra a URL que o `mirante` imprimiu — ela carrega o token.',

  'entry.cli': 'terminal',
  'entry.vscode': 'VS Code',
  'entry.sdk': 'SDK',
  'entry.print': 'claude -p',
  'entry.unknown': '',
};

const DICTIONARIES: Record<Locale, Record<Key, string>> = { en, 'pt-BR': ptBR };

const STORAGE_KEY = 'mirante.locale';

const detectLocale = (): Locale => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;
  } catch {
    // Private mode. Fall through to the browser's own preference.
  }
  return navigator.language?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
};

export type Translate = (key: Key, vars?: Vars) => string;

type I18nValue = { locale: Locale; setLocale: (locale: Locale) => void; t: Translate };

const I18nContext = createContext<I18nValue | undefined>(undefined);

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocale] = useState<Locale>(detectLocale);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(() => {
    const dictionary = DICTIONARIES[locale];
    const t: Translate = (key, vars) => {
      const template = dictionary[key] ?? en[key] ?? key;
      if (!vars) return template;
      return Object.entries(vars).reduce(
        (text, [name, replacement]) => text.split(`{${name}}`).join(String(replacement)),
        template,
      );
    };
    return { locale, setLocale, t };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nValue => {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
};
