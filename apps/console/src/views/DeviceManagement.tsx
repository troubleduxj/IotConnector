import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Save, Download, Upload, Network, Trash2, CheckCircle2, X, Edit2, Search,
  AlertTriangle, HelpCircle, Play, Radio, Loader2,
} from 'lucide-react';
import { PROTOCOL_CONFIGS, getParamSchema, type Protocol } from '@iotconnector/shared';
import {
  createChannel, createTag, deleteChannel, deleteTag, fetchConfig,
  updateChannel, updateTag, type GatewayChannel, type GatewayTag,
} from '../api';
import { useRuntime } from '../store/runtime';

/**
 * 设备与通道管理（PRD M2）：通道/位号配置 CRUD 直连网关 REST，
 * 保存即持久化并热重载驱动（FR-M2-06）；协议专属表单由 shared 的
 * PROTOCOL_PARAM_SCHEMAS 动态渲染（一份 schema 三处用）。
 */

const DATA_TYPES = ['Bool', 'Int16', 'UInt16', 'Int32', 'Float', 'Double', 'String'];

export default function DeviceManagement() {
  const { channels: channelStatus, connect } = useRuntime();
  const [channels, setChannels] = useState<GatewayChannel[]>([]);
  const [tags, setTags] = useState<GatewayTag[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GatewayChannel | null>(null);
  const [protocolFilter, setProtocolFilter] = useState<string>('All');
  const [activeTab, setActiveTab] = useState<'connection' | 'tags'>('connection');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newChannel, setNewChannel] = useState({ name: '', protocol: 'Modbus TCP' as Protocol, host: '192.168.1.100', port: 502 });
  const [tagModal, setTagModal] = useState<{ mode: 'add' | 'edit'; draft: GatewayTag } | null>(null);
  const [tagSearch, setTagSearch] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const loadConfig = async (): Promise<void> => {
    const config = await fetchConfig();
    setChannels(config.channels);
    setTags(config.tags);
    setSelectedId((prev) => (prev && config.channels.some((c) => c.id === prev) ? prev : config.channels[0]?.id ?? null));
  };

  useEffect(() => {
    connect();
    void loadConfig();
  }, [connect]);

  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const selectedTags = useMemo(() => tags.filter((t) => t.channelId === selectedId), [tags, selectedId]);

  // 进入编辑：以当前通道为草稿（保存时 PUT 整体字段）
  useEffect(() => {
    setDraft(selected ? { ...selected, params: { ...selected.params } } : null);
    setActiveTab('connection');
    setTestResult(null);
  }, [selectedId, selected?.name, selected?.host, selected?.port]);

  const filteredChannels = useMemo(
    () =>
      channels.filter((c) => {
        if (protocolFilter === 'All') return true;
        return PROTOCOL_CONFIGS[c.protocol as Protocol]?.category === protocolFilter || c.protocol === protocolFilter;
      }),
    [channels, protocolFilter],
  );

  const filterChips = useMemo(() => {
    const cats = ['All', ...new Set(channels.map((c) => PROTOCOL_CONFIGS[c.protocol as Protocol]?.category ?? c.protocol))];
    return cats;
  }, [channels]);

  const statusOf = (id: string): string => channelStatus[id]?.state ?? '—';

  // ===== 通道保存 / 删除 =====
  const saveChannel = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    try {
      await updateChannel(draft.id, {
        name: draft.name,
        host: draft.host,
        port: Number(draft.port),
        enabled: draft.enabled,
        pollIntervalMs: Number(draft.pollIntervalMs),
        params: draft.params,
      });
      await loadConfig();
      showToast(`通道 "${draft.name}" 已保存并热生效。`);
    } catch (e) {
      showToast(`保存失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeChannel = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`确认删除通道 "${selected.name}" 及其 ${selectedTags.length} 个位号？`)) return;
    setBusy(true);
    try {
      await deleteChannel(selected.id);
      await loadConfig();
      showToast(`通道 "${selected.name}" 已删除。`);
    } finally {
      setBusy(false);
    }
  };

  const addChannel = async (): Promise<void> => {
    if (!newChannel.name.trim()) return;
    setBusy(true);
    try {
      // 协议参数默认值来自 shared schema（一份 schema 三处用）
      const params: Record<string, string | number | boolean> = {};
      for (const f of getParamSchema(newChannel.protocol)) params[f.key] = f.default;
      const created = await createChannel({
        name: newChannel.name.trim(),
        protocol: newChannel.protocol,
        host: newChannel.host,
        port: Number(newChannel.port),
        enabled: true,
        pollIntervalMs: 1000,
        params,
      });
      setIsAddOpen(false);
      await loadConfig();
      setSelectedId(created.id);
      showToast(`通道 "${created.name}" 已创建并连接。`);
    } catch (e) {
      showToast(`创建失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ===== 连接测试（模拟握手摘要，驱动级真实测试在后续阶段）=====
  const runConnectionTest = (): void => {
    if (!draft) return;
    const meta = PROTOCOL_CONFIGS[draft.protocol as Protocol];
    setTestResult(`${meta.standard} 握手序列（模拟）—— TCP 连通 ${draft.host}:${draft.port} → 协议协商成功 → 会话建立。RTT 3ms。`);
    showToast('连接测试完成（模拟输出）。');
  };

  // ===== 位号 CRUD =====
  const openTagAdd = (): void => {
    if (!selected) return;
    setTagModal({
      mode: 'add',
      draft: {
        id: '', channelId: selected.id, name: `${selected.name}.`, address: PROTOCOL_CONFIGS[selected.protocol].sampleAddress,
        dataType: 'Float', unit: '', scale: 1, offset: 0, description: '',
      },
    });
  };

  const submitTag = async (): Promise<void> => {
    if (!tagModal) return;
    setBusy(true);
    try {
      if (tagModal.mode === 'add') await createTag(tagModal.draft);
      else await updateTag(tagModal.draft.id, tagModal.draft);
      setTagModal(null);
      await loadConfig();
      showToast('位号已保存并热生效。');
    } catch (e) {
      showToast(`保存失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeTag = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`确认删除位号 "${name}"？`)) return;
    await deleteTag(id);
    await loadConfig();
    showToast(`位号 "${name}" 已删除。`);
  };

  // ===== 位号 CSV 导入 / 导出 =====
  const exportTagsCsv = (): void => {
    const headers = ['VariableName', 'Address', 'DataType', 'Unit', 'Scale', 'Offset', 'Description'];
    const rows = selectedTags.map((t) =>
      [`"${t.name}"`, `"${t.address}"`, t.dataType, `"${t.unit}"`, t.scale, t.offset, `"${(t.description ?? '').replace(/"/g, '""')}"`].join(','),
    );
    const csv = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows].join('\n');
    const link = document.createElement('a');
    link.href = encodeURI(csv);
    link.download = `${selected?.name ?? 'tags'}_tags_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`已导出 ${selectedTags.length} 个位号。`);
  };

  const importTagsCsv = (file: File): void => {
    if (!selected) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = String(event.target?.result ?? '');
      const lines = content.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length <= 1) {
        showToast('CSV 为空或缺少数据行。');
        return;
      }
      let imported = 0;
      for (let i = 1; i < lines.length; i += 1) {
        const parts = lines[i].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        if (parts.length < 2) continue;
        try {
          await createTag({
            channelId: selected.id,
            name: parts[0] || `Tag_${i}`,
            address: parts[1] || '40001',
            dataType: DATA_TYPES.includes(parts[2]) ? parts[2] : 'Float',
            unit: parts[3] ?? '',
            scale: Number(parts[4]) || 1,
            offset: Number(parts[5]) || 0,
            description: parts[6] ?? 'CSV 导入',
          });
          imported += 1;
        } catch {
          /* 跳过失败行 */
        }
      }
      await loadConfig();
      showToast(`成功导入 ${imported} 个位号。`);
    };
    reader.readAsText(file);
  };

  const filteredTagList = selectedTags.filter(
    (t) => t.name.toLowerCase().includes(tagSearch.toLowerCase()) || t.address.toLowerCase().includes(tagSearch.toLowerCase()),
  );
  const paramSchema = draft ? getParamSchema(draft.protocol as Protocol) : [];
  const meta = draft ? PROTOCOL_CONFIGS[draft.protocol as Protocol] : null;

  return (
    <div className="space-y-6">
      {toast && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl border border-slate-700">
          {toast}
        </div>
      )}

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">设备与通道管理</h2>
          <p className="text-sm text-slate-500 mt-1">通道配置直连网关，保存即持久化并热生效。</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-4 h-4 mr-2" /> 新增通道
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 通道列表 */}
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-100 bg-slate-50/70">
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-slate-800 text-sm flex items-center gap-1.5">
                <Network className="w-4 h-4 text-indigo-600" /> 工业通道 ({channels.length})
              </span>
            </div>
            <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[10px]">
              {filterChips.map((chip) => (
                <button
                  key={chip}
                  onClick={() => setProtocolFilter(chip)}
                  className={`px-2 py-0.5 rounded whitespace-nowrap font-medium transition-colors ${
                    protocolFilter === chip ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {chip === 'All' ? '全部' : chip}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 max-h-[560px]">
            {filteredChannels.map((channel) => {
              const cMeta = PROTOCOL_CONFIGS[channel.protocol as Protocol];
              const st = statusOf(channel.id);
              const isSelected = channel.id === selectedId;
              return (
                <button
                  key={channel.id}
                  onClick={() => setSelectedId(channel.id)}
                  className={`w-full text-left p-3.5 transition-colors ${isSelected ? 'bg-indigo-50/50 border-l-2 border-indigo-500' : 'hover:bg-slate-50 border-l-2 border-transparent'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-xs text-slate-800 truncate">{channel.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border shrink-0 ${cMeta?.color ?? ''}`}>
                      {channel.protocol.split(' ')[0]}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[10px] font-mono text-slate-400">
                      {channel.host}:{channel.port} · {tags.filter((t) => t.channelId === channel.id).length} 位号
                    </span>
                    <span className="flex items-center gap-1 text-[10px] font-semibold">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          st === 'online' ? 'bg-green-500' : st === 'connecting' ? 'bg-amber-400 animate-pulse' : st === 'disabled' ? 'bg-slate-300' : 'bg-rose-500'
                        }`}
                      />
                      <span className={st === 'online' ? 'text-green-600' : st === 'offline' || st === 'error' ? 'text-rose-500' : 'text-slate-400'}>
                        {st === 'online' ? '在线' : st === 'connecting' ? '连接中' : st === 'disabled' ? '停用' : '离线'}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 详情面板 */}
        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {!draft || !selected ? (
            <div className="p-12 text-center text-slate-400 text-sm">选择左侧通道查看配置。</div>
          ) : (
            <>
              {/* 头部 */}
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
                <div className="flex items-center gap-3">
                  <div>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      className="font-bold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none text-base w-56"
                    />
                    <div className="text-[11px] font-mono text-slate-400 mt-0.5">{meta?.standard}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${meta?.color ?? ''}`}>{draft.protocol}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                    className={`px-2.5 py-1 rounded-md text-xs font-bold border transition-colors ${
                      draft.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-200'
                    }`}
                  >
                    {draft.enabled ? '启用中' : '已停用'}
                  </button>
                  <button
                    onClick={() => void removeChannel()}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                    title="删除通道"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => void saveChannel()}
                    disabled={busy}
                    className="flex items-center px-3.5 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} 保存并生效
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="px-6 border-b border-slate-200 flex gap-1">
                {(['connection', 'tags'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === tab ? 'text-indigo-600 border-indigo-600' : 'text-slate-500 hover:text-slate-700 border-transparent'
                    }`}
                  >
                    {tab === 'connection' ? '连接参数' : `位号映射 (${selectedTags.length})`}
                  </button>
                ))}
              </div>

              {activeTab === 'connection' && (
                <div className="p-6 space-y-5">
                  {/* 基础字段 */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">目标地址 / 主机</label>
                      <input
                        value={draft.host}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">端口</label>
                      <input
                        value={draft.port}
                        onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">采集周期 (ms)</label>
                      <input
                        value={draft.pollIntervalMs}
                        onChange={(e) => setDraft({ ...draft, pollIntervalMs: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">运行状态</label>
                      <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm font-mono text-slate-600">
                        {statusOf(draft.id)}
                      </div>
                    </div>
                  </div>

                  {/* 协议专属参数（schema 动态渲染） */}
                  <div className="pt-2 border-t border-slate-100">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                        {draft.protocol} 驱动选项
                      </h4>
                      <button
                        onClick={runConnectionTest}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                      >
                        <Play className="w-3 h-3 text-emerald-600" /> 测试连接（模拟）
                      </button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {paramSchema.map((field) => {
                        const value = draft.params[field.key];
                        const set = (v: string | number | boolean): void =>
                          setDraft({ ...draft, params: { ...draft.params, [field.key]: v } });
                        return (
                          <div key={field.key}>
                            <label className="block text-xs font-semibold text-slate-600 mb-1.5">{field.label}</label>
                            {field.type === 'select' ? (
                              <select
                                value={String(value ?? field.default)}
                                onChange={(e) => set(e.target.value)}
                                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-medium bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                              >
                                {field.options?.map((o) => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            ) : field.type === 'boolean' ? (
                              <button
                                onClick={() => set(!value)}
                                className={`px-3 py-2 w-full rounded-md text-xs font-bold border ${
                                  value ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-50 text-slate-500 border-slate-200'
                                }`}
                              >
                                {value ? '是' : '否'}
                              </button>
                            ) : (
                              <input
                                type={field.type === 'number' ? 'number' : 'text'}
                                value={String(value ?? '')}
                                min={field.min}
                                max={field.max}
                                step={field.step}
                                onChange={(e) => set(field.type === 'number' ? Number(e.target.value) : e.target.value)}
                                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                              />
                            )}
                            {field.help && (
                              <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                                <HelpCircle className="w-3 h-3" /> {field.help}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {testResult && (
                    <div className="px-4 py-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-mono flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> {testResult}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'tags' && (
                <div className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="relative w-64">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                      <input
                        placeholder="搜索位号、地址…"
                        value={tagSearch}
                        onChange={(e) => setTagSearch(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importTagsCsv(f); if (fileInputRef.current) fileInputRef.current.value = ''; }} />
                      <button onClick={() => fileInputRef.current?.click()} className="flex items-center px-2.5 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
                        <Upload className="w-3.5 h-3.5 mr-1" /> 导入 CSV
                      </button>
                      <button onClick={exportTagsCsv} className="flex items-center px-2.5 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
                        <Download className="w-3.5 h-3.5 mr-1" /> 导出 CSV
                      </button>
                      <button onClick={openTagAdd} className="flex items-center px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700">
                        <Plus className="w-3.5 h-3.5 mr-1" /> 新增位号
                      </button>
                    </div>
                  </div>

                  <div className="overflow-x-auto border border-slate-100 rounded-lg">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500 text-[10px] uppercase font-bold tracking-wider border-b border-slate-200">
                          <th className="px-4 py-2.5">位号名</th>
                          <th className="px-4 py-2.5">地址</th>
                          <th className="px-4 py-2.5">类型</th>
                          <th className="px-4 py-2.5">单位</th>
                          <th className="px-4 py-2.5">标度</th>
                          <th className="px-4 py-2.5 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredTagList.map((tag) => (
                          <tr key={tag.id} className="hover:bg-slate-50/80">
                            <td className="px-4 py-2.5 font-mono font-bold text-slate-800">
                              {tag.name}
                              {tag.description && <span className="ml-2 text-[10px] text-slate-400 font-normal">{tag.description}</span>}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-slate-500">{tag.address}</td>
                            <td className="px-4 py-2.5"><span className="px-1.5 py-0.5 bg-slate-100 rounded text-[10px] font-bold">{tag.dataType}</span></td>
                            <td className="px-4 py-2.5 font-mono text-slate-500">{tag.unit || '—'}</td>
                            <td className="px-4 py-2.5 font-mono text-slate-500">
                              ×{tag.scale} {tag.offset !== 0 ? `${tag.offset > 0 ? '+' : ''}${tag.offset}` : ''}
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <button onClick={() => setTagModal({ mode: 'edit', draft: { ...tag } })} className="p-1.5 text-slate-400 hover:text-indigo-600 rounded-md hover:bg-indigo-50 mr-1" title="编辑">
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => void removeTag(tag.id, tag.name)} className="p-1.5 text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50" title="删除">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {filteredTagList.length === 0 && (
                          <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">暂无位号，点击右上角新增。</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 新增通道弹窗 */}
      {isAddOpen && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <Radio className="w-4 h-4 text-indigo-600" /> 新增通道
              </h3>
              <button onClick={() => setIsAddOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">通道名称 *</label>
                <input
                  value={newChannel.name}
                  onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })}
                  placeholder="如 R0023_S7_1200"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">协议</label>
                <select
                  value={newChannel.protocol}
                  onChange={(e) => {
                    const protocol = e.target.value as Protocol;
                    const schemaPort = getParamSchema(protocol).find((f) => f.key === 'port');
                    setNewChannel({ ...newChannel, protocol, port: Number(PROTOCOL_CONFIGS[protocol].defaultPort) || Number(schemaPort?.default ?? 502) });
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-medium bg-slate-50"
                >
                  {Object.values(PROTOCOL_CONFIGS).map((m) => (
                    <option key={m.name} value={m.name}>{m.name}（默认端口 {m.defaultPort}）</option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">{PROTOCOL_CONFIGS[newChannel.protocol].description}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">主机地址</label>
                  <input
                    value={newChannel.host}
                    onChange={(e) => setNewChannel({ ...newChannel, host: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">端口</label>
                  <input
                    value={newChannel.port}
                    onChange={(e) => setNewChannel({ ...newChannel, port: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                  />
                </div>
              </div>
              <div className="px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-[11px] text-amber-700 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                创建后通道立即按协议默认参数连接；专属参数可在保存前于连接参数页调整。
              </div>
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
              <button onClick={() => setIsAddOpen(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-md">取消</button>
              <button
                onClick={() => void addChannel()}
                disabled={busy || !newChannel.name.trim()}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-md flex items-center"
              >
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />} 创建并连接
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 位号新增/编辑弹窗 */}
      {tagModal && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-semibold text-slate-800">{tagModal.mode === 'add' ? '新增位号' : '编辑位号'}</h3>
              <button onClick={() => setTagModal(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-4 max-h-[65vh] overflow-y-auto">
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">位号名 *（通道内唯一）</label>
                <input
                  value={tagModal.draft.name}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, name: e.target.value } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  协议地址 *
                  <span className="ml-2 text-[10px] text-slate-400 font-normal">
                    语法：{meta?.addressSyntaxHelp}
                  </span>
                </label>
                <input
                  value={tagModal.draft.address}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, address: e.target.value } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">数据类型</label>
                <select
                  value={tagModal.draft.dataType}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, dataType: e.target.value } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-medium bg-slate-50"
                >
                  {DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">单位</label>
                <input
                  value={tagModal.draft.unit}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, unit: e.target.value } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">标度（工程值 = 原始 × scale + offset）</label>
                <input
                  value={tagModal.draft.scale}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, scale: Number(e.target.value) } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">偏移</label>
                <input
                  value={tagModal.draft.offset}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, offset: Number(e.target.value) } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">工程量程下限（归一化用）</label>
                <input
                  value={tagModal.draft.engMin ?? ''}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, engMin: e.target.value === '' ? undefined : Number(e.target.value) } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">工程量程上限</label>
                <input
                  value={tagModal.draft.engMax ?? ''}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, engMax: e.target.value === '' ? undefined : Number(e.target.value) } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">描述</label>
                <input
                  value={tagModal.draft.description ?? ''}
                  onChange={(e) => setTagModal({ ...tagModal, draft: { ...tagModal.draft, description: e.target.value } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                />
              </div>
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
              <button onClick={() => setTagModal(null)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-md">取消</button>
              <button
                onClick={() => void submitTag()}
                disabled={busy || !tagModal.draft.name || !tagModal.draft.address}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-md flex items-center"
              >
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />} 保存并热生效
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
