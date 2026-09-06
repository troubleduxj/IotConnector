import React, { createContext, useContext, useState } from 'react';

/**
 * 轻量 i18n（PRD FR-M10-05 / 决策 D3）：中文优先，英文包可选。
 * t(key) 缺失时回落中文，再缺失返回 key 本身。
 */

export type Lang = 'zh' | 'en';

const zh: Record<string, string> = {
  'nav.dashboard': '仪表盘',
  'nav.devices': '设备管理',
  'nav.scheduler': '采集调度',
  'nav.storage': '存储规则',
  'nav.diagnose': '参数诊断',
  'nav.recipes': '配方管理',
  'nav.historian': '历史查询',
  'nav.scripts': '边缘脚本',
  'nav.alarms': '告警中心',
  'nav.settings': '系统配置',
  'nav.group': '核心系统',
  'header.live': '系统运行中',
  'header.connecting': '连接中…',
  'header.offline': '网关离线',
  'header.logout': '退出',
  'header.lang': 'EN',
  'login.title': '登录 Factory Bridge',
  'login.subtitle': '企业级工业物联网边缘网关控制台',
  'login.username': '用户名',
  'login.password': '口令',
  'login.submit': '登 录',
  'login.error': '用户名或口令错误',
  'login.hint': '预置账号：admin / engineer / operator（口令为账号名+123）',
  'alarms.title': '告警中心',
  'alarms.subtitle': '告警规则、活动告警与历史事件查询',
  'alarms.active': '活动告警',
  'alarms.rules': '告警规则',
  'alarms.history': '历史事件',
  'alarms.filter.tag': '位号',
  'alarms.filter.state': '状态',
  'alarms.filter.all': '全部',
  'alarms.filter.query': '查询',
  'alarms.empty': '暂无数据',
  'alarms.prev': '上一页',
  'alarms.next': '下一页',
  'common.online': '在线',
  'common.offline': '离线',
};

const en: Record<string, string> = {
  'nav.dashboard': 'Dashboard',
  'nav.devices': 'Device Management',
  'nav.scheduler': 'Acquisition Scheduler',
  'nav.storage': 'Data Storage Rules',
  'nav.diagnose': 'Parameter Diagnose',
  'nav.recipes': 'Recipe Management',
  'nav.historian': 'Historian Query',
  'nav.scripts': 'Edge Scripts',
  'nav.alarms': 'Alarm Center',
  'nav.settings': 'System Config',
  'nav.group': 'Core Systems',
  'header.live': 'Live System',
  'header.connecting': 'Connecting…',
  'header.offline': 'Gateway Offline',
  'header.logout': 'Sign out',
  'header.lang': '中文',
  'login.title': 'Sign in to Factory Bridge',
  'login.subtitle': 'Enterprise IIoT Edge Gateway Console',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.error': 'Incorrect username or password',
  'login.hint': 'Seeded accounts: admin / engineer / operator (password: name + 123)',
  'alarms.title': 'Alarm Center',
  'alarms.subtitle': 'Alarm rules, active alarms and history query',
  'alarms.active': 'Active Alarms',
  'alarms.rules': 'Rules',
  'alarms.history': 'History',
  'alarms.filter.tag': 'Tag',
  'alarms.filter.state': 'State',
  'alarms.filter.all': 'All',
  'alarms.filter.query': 'Query',
  'alarms.empty': 'No data',
  'alarms.prev': 'Prev',
  'alarms.next': 'Next',
  'common.online': 'Online',
  'common.offline': 'Offline',
};

const dictionaries: Record<Lang, Record<string, string>> = { zh, en };

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
}

const LangContext = createContext<I18nContextValue>({
  lang: 'zh',
  setLang: () => {},
  t: (k) => k,
});

const LANG_KEY = 'fb_lang';

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [lang, setLangState] = useState<Lang>((localStorage.getItem(LANG_KEY) as Lang) ?? 'zh');
  const setLang = (l: Lang): void => {
    localStorage.setItem(LANG_KEY, l);
    setLangState(l);
  };
  const t = (key: string): string => dictionaries[lang][key] ?? zh[key] ?? key;
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(LangContext);
}
