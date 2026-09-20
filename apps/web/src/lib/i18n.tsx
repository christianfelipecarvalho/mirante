import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const LOCALES = ['en', 'pt-BR'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABEL: Record<Locale, string> = { en: 'EN', 'pt-BR': 'PT' };

type Vars = Record<string, string | number>;

const en = {
  'brand.tagline': 'Local lookout for coding agents',

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
  'plan.hint.editorOnly': 'no status line outside the terminal',
  'plan.hint.needsPlan': 'needs Pro or Max, after one reply',
  'plan.resetting': 'resetting',
  'plan.resetsInMinutes': 'resets in {n}m',
  'plan.resetsInHours': 'resets in {n}h',
  'plan.resetsOn': 'resets {date}',

  'filter.project': 'Project',
  'filter.allProjects': 'All projects',
  'filter.hideFinished': 'Hide finished',

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
  'waiting.plan_limit': 'At the {subject}',
  'waiting.for': 'waiting {duration}',

  'card.session': 'Session',
  'card.subagent': 'subagent',
  'card.mainSession': 'main session',
  'card.lastAction': 'last action',
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
  'detail.request': 'Request',
  'detail.requestAt': 'sent {time}',
  'detail.agentsSpawned': 'Agents',
  'detail.toolsRun': 'Tools',
  'detail.duration': 'Duration',
  'detail.stillRunning': 'still running',
  'detail.toolsFailed': '{count} failed',
  'detail.planAtTime': 'Plan usage',
  'detail.planUnknown': 'not reported',

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
  'plan.hint.editorOnly': 'sem status line fora do terminal',
  'plan.hint.needsPlan': 'precisa de Pro ou Max, após a primeira resposta',
  'plan.resetting': 'reiniciando',
  'plan.resetsInMinutes': 'reinicia em {n}min',
  'plan.resetsInHours': 'reinicia em {n}h',
  'plan.resetsOn': 'reinicia {date}',

  'filter.project': 'Projeto',
  'filter.allProjects': 'Todos os projetos',
  'filter.hideFinished': 'Ocultar encerradas',

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
  'waiting.plan_limit': 'No {subject}',
  'waiting.for': 'esperando há {duration}',

  'card.session': 'Sessão',
  'card.subagent': 'subagente',
  'card.mainSession': 'sessão principal',
  'card.lastAction': 'última ação',
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
  'detail.request': 'Solicitação',
  'detail.requestAt': 'enviada {time}',
  'detail.agentsSpawned': 'Agentes',
  'detail.toolsRun': 'Ferramentas',
  'detail.duration': 'Duração',
  'detail.stillRunning': 'ainda rodando',
  'detail.toolsFailed': '{count} falharam',
  'detail.planAtTime': 'Uso do plano',
  'detail.planUnknown': 'não reportado',

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
