import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  LineChart as RechartsLineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, 
  Legend, ResponsiveContainer, Area, ComposedChart, ReferenceLine
} from 'recharts';
import { fetchHistory, fetchGatewayTags, type GatewayTag, type HistorySeries } from '../api';
import { useRuntime } from '../store/runtime';
import { useI18n } from '../i18n';
import {
  Calendar, Download, Search, RefreshCw, Layers, CheckSquare, Square,
  X, Filter, Eye, EyeOff, BarChart2, TrendingUp, Sliders, Image, FileSpreadsheet,
  FileText, Clock, Sparkles, Activity, Check, CheckCircle2, ChevronDown, ChevronRight,
  Maximize2, ArrowUpDown, HelpCircle, AlertTriangle, ChevronLeft
} from 'lucide-react';
import { Tag } from '../types';

// Distinct palette for multiple tag comparison
const TAG_COLORS = [
  '#4f46e5', // Indigo
  '#059669', // Emerald
  '#d97706', // Amber
  '#e11d48', // Rose
  '#0891b2', // Cyan
  '#9333ea', // Purple
  '#ea580c', // Orange
  '#0d9488', // Teal
];

type TimePreset = '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom';
type ScalingMode = 'raw' | 'normalized' | 'dual';
type CurveType = 'monotone' | 'linear' | 'step';

interface DataPoint {
  timestamp: string;
  epoch: number;
  [key: string]: number | string;
}

interface TagStat {
  tagId: string;
  name: string;
  unit: string;
  color: string;
  min: number;
  max: number;
  avg: number;
  current: number;
  stdDev: number;
  count: number;
  quality: 'Good' | 'Uncertain' | 'Bad' | 'NoData';
}

/** 时间窗预设 → 毫秒跨度 */
function presetSpanMs(preset: TimePreset, customStart: string, customEnd: string): { start: number; end: number } {
  const end = Date.now();
  if (preset === 'custom') {
    return { start: Date.parse(customStart) || end - 3600_000, end: Date.parse(customEnd) || end };
  }
  const spans: Record<string, number> = {
    '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3,
    '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3,
  };
  return { start: end - (spans[preset] ?? 3600e3), end };
}

export default function Historian() {
  const { t } = useI18n();
  // Tag Selection & Search
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(['1', '2', '5']); // Default: pH, Temp, Speed
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedChannelFilter, setSelectedChannelFilter] = useState('All');
  const [tagVisibility, setTagVisibility] = useState<Record<string, boolean>>({});

  // Time Range States
  const [timePreset, setTimePreset] = useState<TimePreset>('1h');
  const [customStartDate, setCustomStartDate] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 1);
    return d.toISOString().slice(0, 16);
  });
  const [customEndDate, setCustomEndDate] = useState(() => {
    return new Date().toISOString().slice(0, 16);
  });
  const [samplingInterval, setSamplingInterval] = useState<'1s' | '5s' | '1m' | '5m'>('1m');
  const [isAutoRefresh, setIsAutoRefresh] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Visualization Modes
  const [scalingMode, setScalingMode] = useState<ScalingMode>('raw');
  const [curveType, setCurveType] = useState<CurveType>('monotone');
  const [showAreaGradient, setShowAreaGradient] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showDataPoints, setShowDataPoints] = useState(false);

  // Export State
  const [isExporting, setIsExporting] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const chartContainerRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // ===== 真实位号列表（网关 /api/tags，单一数据源）=====
  const [gatewayTags, setGatewayTags] = useState<GatewayTag[]>([]);
  useEffect(() => {
    fetchGatewayTags().then(setGatewayTags).catch(() => setGatewayTags([]));
  }, []);

  const channels = useMemo(() => {
    const set = new Set(gatewayTags.map(t => t.channelId));
    return ['All', ...Array.from(set)];
  }, [gatewayTags]);

  const filteredAvailableTags = useMemo(() => {
    return gatewayTags.filter(tag => {
      const matchSearch =
        tag.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tag.channelId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tag.dataType.toLowerCase().includes(searchQuery.toLowerCase());
      const matchChannel = selectedChannelFilter === 'All' || tag.channelId === selectedChannelFilter;
      return matchSearch && matchChannel;
    });
  }, [gatewayTags, searchQuery, selectedChannelFilter]);

  // 位号选择器分页（PRD FR-M7-01）
  const TAG_PAGE_SIZE = 8;
  const [tagPage, setTagPage] = useState(0);
  const tagTotalPages = Math.max(1, Math.ceil(filteredAvailableTags.length / TAG_PAGE_SIZE));
  const safeTagPage = Math.min(tagPage, tagTotalPages - 1);
  const pagedTags = useMemo(
    () => filteredAvailableTags.slice(safeTagPage * TAG_PAGE_SIZE, (safeTagPage + 1) * TAG_PAGE_SIZE),
    [filteredAvailableTags, safeTagPage],
  );
  useEffect(() => {
    setTagPage(0);
  }, [searchQuery, selectedChannelFilter]);

  // 选中位号元数据：单位直接取位号模型（不再按名字猜测），颜色按选择顺序分配
  const activeTags = useMemo(() => {
    return selectedTagIds
      .map((id, index) => {
        const tag = gatewayTags.find(t => t.id === id);
        if (!tag) return null;
        return {
          id: tag.id,
          name: tag.name,
          channel: tag.channelId,
          dataType: tag.dataType,
          unit: tag.unit,
          color: TAG_COLORS[index % TAG_COLORS.length],
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  }, [selectedTagIds, gatewayTags]);

  // Toggle tag selection
  const handleToggleTag = (id: string) => {
    setSelectedTagIds(prev => {
      if (prev.includes(id)) {
        if (prev.length === 1) {
          showToast('At least one tag must remain selected.');
          return prev;
        }
        return prev.filter(tId => tId !== id);
      } else {
        if (prev.length >= 8) {
          showToast('Maximum 8 tags can be compared simultaneously.');
          return prev;
        }
        return [...prev, id];
      }
    });
  };

  // Toggle single tag line visibility on chart
  const handleToggleVisibility = (tagId: string) => {
    setTagVisibility(prev => ({
      ...prev,
      [tagId]: prev[tagId] === undefined ? false : !prev[tagId]
    }));
  };

  // ===== 真实历史数据：/api/history（服务端聚合 + 降采样） =====
  const { liveValues } = useRuntime();
  const [historyData, setHistoryData] = useState<HistorySeries[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const samplingSec = timePreset === 'custom'
    ? { '1s': 1, '5s': 5, '1m': 60, '5m': 300 }[samplingInterval]
    : undefined; // 预设窗口由服务端按数据量自动降采样

  useEffect(() => {
    if (!selectedTagIds.length) return;
    const controller = new AbortController();
    const { start, end } = presetSpanMs(timePreset, customStartDate, customEndDate);
    setIsLoading(true);
    setDataError(null);
    fetchHistory(selectedTagIds, start, end, samplingSec, controller.signal)
      .then((res) => setHistoryData(res.series))
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setDataError(String(e.message ?? e));
        setHistoryData(null);
      })
      .finally(() => setIsLoading(false));
    return () => controller.abort();
  }, [selectedTagIds, timePreset, customStartDate, customEndDate, samplingSec, refreshTrigger]);

  // Auto-refresh interval
  useEffect(() => {
    if (!isAutoRefresh) return;
    const interval = setInterval(() => {
      setRefreshTrigger(prev => prev + 1);
    }, 5000);
    return () => clearInterval(interval);
  }, [isAutoRefresh]);

  const windowSpanH = (presetSpanMs(timePreset, customStartDate, customEndDate).end -
    presetSpanMs(timePreset, customStartDate, customEndDate).start) / 3600e3;

  // 服务端聚合结果 → 图表行（按桶时间对齐各位号；归一化基于工程量程或窗口极值）
  const chartData = useMemo<DataPoint[]>(() => {
    if (!historyData) return [];
    const bucketFmt: Intl.DateTimeFormatOptions = windowSpanH >= 6
      ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const rows = new Map<string, DataPoint>();
    for (const series of historyData) {
      if (series.error || !series.points.length) continue;
      const min = Math.min(...series.points.map(p => p.min));
      const max = Math.max(...series.points.map(p => p.max));
      const base = series.engMin != null && series.engMax != null ? series.engMin : min;
      const range = series.engMin != null && series.engMax != null
        ? (series.engMax - series.engMin) || 1
        : (max - min) || 1;
      for (const p of series.points) {
        let row = rows.get(p.t);
        if (!row) {
          row = { timestamp: new Date(p.t).toLocaleTimeString([], bucketFmt), epoch: Date.parse(p.t) };
          rows.set(p.t, row);
        }
        row[series.tagId] = Number(p.avg.toFixed(4));
        row[`${series.tagId}_norm`] = Number(
          Math.min(100, Math.max(0, ((p.avg - base) / range) * 100)).toFixed(1)
        );
      }
    }
    return [...rows.values()].sort((a, b) => a.epoch - b.epoch);
  }, [historyData, windowSpanH]);

  // 统计包络：来自服务端聚合；Latest 取实时值（runtime store），质量为真实质量
  const tagStatistics: TagStat[] = useMemo(() => {
    if (!historyData) return [];
    return activeTags.flatMap(tag => {
      const series = historyData.find(s => s.tagId === tag.id);
      if (!series || series.error || !series.stats) return [];
      const st = series.stats;
      const latest = liveValues[tag.id];
      const current = typeof latest?.value === 'number'
        ? latest.value
        : series.points[series.points.length - 1]?.avg ?? 0;
      return [{
        tagId: tag.id,
        name: series.name ?? tag.name,
        unit: series.unit ?? tag.unit,
        color: tag.color,
        min: Number((st.min ?? 0).toFixed(2)),
        max: Number((st.max ?? 0).toFixed(2)),
        avg: Number((st.avg ?? 0).toFixed(2)),
        current: Number(Number(current).toFixed(2)),
        stdDev: Number((st.stdDev ?? 0).toFixed(2)),
        count: st.count,
        quality: latest?.quality ?? (st.count > 0 ? 'Good' : 'NoData'),
      }];
    });
  }, [activeTags, historyData, liveValues]);

  // Quick Preset Selection presets
  const handleSelectQuickGroup = (type: 'all' | 'reactors' | 'drives' | 'clear') => {
    if (type === 'all') {
      setSelectedTagIds(gatewayTags.slice(0, 6).map(t => t.id));
      showToast(t('hist.toast.top6'));
    } else if (type === 'reactors') {
      setSelectedTagIds(gatewayTags.filter(t => t.channelId.includes('s7-01')).map(t => t.id));
      showToast(t('hist.toast.reactor'));
    } else if (type === 'drives') {
      setSelectedTagIds(gatewayTags.filter(t => t.channelId.includes('mb-01')).map(t => t.id));
      showToast(t('hist.toast.drives'));
    } else {
      setSelectedTagIds(gatewayTags.length ? [gatewayTags[0].id] : []);
      showToast(t('hist.toast.reset'));
    }
  };

  // EXPORT 1: Export Chart as PNG Image
  const handleExportPNG = () => {
    setIsExporting(true);
    try {
      const container = chartContainerRef.current;
      if (!container) return;

      const svgElement = container.querySelector('svg');
      if (!svgElement) {
        showToast('Unable to find SVG chart element.');
        setIsExporting(false);
        return;
      }

      // Serialize SVG to XML string
      const serializer = new XMLSerializer();
      let svgString = serializer.serializeToString(svgElement);

      // Add XML namespace if missing
      if (!svgString.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)) {
        svgString = svgString.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
      }

      const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const blobURL = URL.createObjectURL(svgBlob);

      const image = new window.Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        const padding = 40;
        const headerHeight = 90;
        const footerHeight = 70;
        
        canvas.width = svgElement.clientWidth * 2 + padding * 2;
        canvas.height = svgElement.clientHeight * 2 + headerHeight + footerHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Header Border & Title
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 28px sans-serif';
        ctx.fillText('FactoryBridge Industrial Historian Trend Export', padding, 45);

        // Subtitle & Time metadata
        ctx.fillStyle = '#64748b';
        ctx.font = '16px sans-serif';
        const dateStr = new Date().toLocaleString();
        const timeRangeStr = timePreset === 'custom' 
          ? `${customStartDate} ~ ${customEndDate}` 
          : `Preset: Last ${timePreset.toUpperCase()}`;
        ctx.fillText(`Time Window: ${timeRangeStr}  |  Generated: ${dateStr}  |  Tags: ${activeTags.map(t => t.name).join(', ')}`, padding, 75);

        // Top separator line
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padding, 88);
        ctx.lineTo(canvas.width - padding, 88);
        ctx.stroke();

        // Draw Chart
        ctx.drawImage(image, padding, headerHeight, svgElement.clientWidth * 2, svgElement.clientHeight * 2);

        // Footer with tag summary stats
        const footerY = headerHeight + svgElement.clientHeight * 2 + 30;
        ctx.beginPath();
        ctx.moveTo(padding, footerY - 15);
        ctx.lineTo(canvas.width - padding, footerY - 15);
        ctx.stroke();

        ctx.font = '14px monospace';
        let xOffset = padding;
        tagStatistics.forEach(stat => {
          ctx.fillStyle = stat.color;
          ctx.fillRect(xOffset, footerY, 12, 12);
          ctx.fillStyle = '#334155';
          ctx.fillText(`${stat.name}: Avg ${stat.avg}${stat.unit} (Min ${stat.min}, Max ${stat.max})`, xOffset + 18, footerY + 11);
          xOffset += 320;
        });

        // Trigger download
        const pngURL = canvas.toDataURL('image/png');
        const downloadLink = document.createElement('a');
        downloadLink.download = `Historian_Trend_${Date.now()}.png`;
        downloadLink.href = pngURL;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(blobURL);

        showToast('Chart image (PNG) exported successfully.');
        setIsExporting(false);
      };

      image.src = blobURL;
    } catch (err) {
      console.error(err);
      showToast('Image export failed, please try again.');
      setIsExporting(false);
    }
  };

  // EXPORT 2: Export Data as CSV / Excel
  const handleExportCSV = () => {
    const headers = ['Timestamp', 'Epoch_ms', ...activeTags.map(t => `"${t.name} (${t.unit || 'value'})"`)];
    const rows = chartData.map(row => {
      const tagVals = activeTags.map(t => row[t.id]);
      return [`"${row.timestamp}"`, row.epoch, ...tagVals].join(',');
    });

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Historian_Data_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Exported ${chartData.length} records to CSV.`);
  };

  // EXPORT 3: Export SVG Vector
  const handleExportSVG = () => {
    const container = chartContainerRef.current;
    if (!container) return;
    const svgElement = container.querySelector('svg');
    if (!svgElement) return;

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgElement);
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Historian_Vector_${Date.now()}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Vector chart (SVG) exported.');
  };

  return (
    <div className="space-y-6">
      {/* Toast Feedback */}
      {toastMessage && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl flex items-center gap-2 border border-slate-700 animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* TOP CONTROL BAR: Tag Search, Time Range & Action Buttons */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
        {/* Row 1: Time Presets & Custom Range */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          {/* Time range presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 mr-2">
              <Clock className="w-4 h-4 text-indigo-600" />
              <span>Time Window:</span>
            </div>
            {(['15m', '1h', '6h', '24h', '7d', '30d', 'custom'] as TimePreset[]).map(preset => (
              <button
                key={preset}
                onClick={() => setTimePreset(preset)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  timePreset === preset
                    ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
              >
                {preset === 'custom' ? 'Custom Range' : preset.toUpperCase()}
              </button>
            ))}

            {/* Live Auto-Refresh Toggle */}
            <button
              onClick={() => setIsAutoRefresh(!isAutoRefresh)}
              className={`ml-2 px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-1.5 transition-all ${
                isAutoRefresh
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-300 animate-pulse'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-600 border-slate-200'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isAutoRefresh ? 'animate-spin' : ''}`} />
              {isAutoRefresh ? 'Live Auto-Polling' : 'Polling Paused'}
            </button>
          </div>

          {/* Export Actions */}
          <div className="flex items-center gap-2 self-end lg:self-auto">
            <button
              onClick={handleExportPNG}
              disabled={isExporting}
              className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Image className="w-3.5 h-3.5" />
              <span>{isExporting ? 'Generating PNG...' : 'Export Chart PNG'}</span>
            </button>

            <button
              onClick={handleExportSVG}
              className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-lg shadow-sm transition-all flex items-center gap-1.5"
              title="Download vector SVG format"
            >
              <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
              <span>SVG</span>
            </button>

            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-lg shadow-sm transition-all flex items-center gap-1.5"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Row 2: Custom DateTime Picker (Conditional) */}
        {timePreset === 'custom' && (
          <div className="p-3.5 bg-indigo-50/50 rounded-xl border border-indigo-100 flex flex-wrap items-center gap-4 text-xs animate-in fade-in slide-in-from-top-1">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-indigo-600" />
              <span className="font-bold text-slate-700">Start Time:</span>
              <input 
                type="datetime-local" 
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="px-2.5 py-1 bg-white border border-slate-300 rounded-md font-mono text-slate-700"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-700">End Time:</span>
              <input 
                type="datetime-local" 
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="px-2.5 py-1 bg-white border border-slate-300 rounded-md font-mono text-slate-700"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-700">Resample:</span>
              <select 
                value={samplingInterval}
                onChange={(e) => setSamplingInterval(e.target.value as any)}
                className="px-2 py-1 bg-white border border-slate-300 rounded-md text-slate-700 font-semibold"
              >
                <option value="1s">1s (Raw Points)</option>
                <option value="5s">5s Average</option>
                <option value="1m">1m Interpolated</option>
                <option value="5m">5m Envelope</option>
              </select>
            </div>
            <button
              onClick={() => {
                setRefreshTrigger(prev => prev + 1);
                showToast('Custom time range applied.');
              }}
              className="px-3 py-1 bg-indigo-600 text-white font-bold rounded-md hover:bg-indigo-700"
            >
              Apply Range
            </button>
          </div>
        )}

        {/* Row 3: Quick Tag Selection Presets & Chart Display Mode Switches */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
          {/* Quick presets */}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="font-bold text-slate-500">Quick Comparison:</span>
            <button 
              onClick={() => handleSelectQuickGroup('all')}
              className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium"
            >
              Top 6 Metrics
            </button>
            <button 
              onClick={() => handleSelectQuickGroup('reactors')}
              className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium"
            >
              Reactor R0021
            </button>
            <button 
              onClick={() => handleSelectQuickGroup('drives')}
              className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium"
            >
              Drives & Motion
            </button>
            <button 
              onClick={() => handleSelectQuickGroup('clear')}
              className="px-2.5 py-1 text-rose-600 hover:bg-rose-50 rounded font-medium"
            >
              Reset
            </button>
          </div>

          {/* Chart Display Controls */}
          <div className="flex items-center gap-2 text-xs flex-wrap">
            {/* Scaling Mode */}
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
              <button
                onClick={() => setScalingMode('raw')}
                className={`px-2.5 py-1 rounded font-bold transition-all ${
                  scalingMode === 'raw' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
                title="Display raw physical engineering units"
              >
                Raw Values
              </button>
              <button
                onClick={() => setScalingMode('normalized')}
                className={`px-2.5 py-1 rounded font-bold transition-all ${
                  scalingMode === 'normalized' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
                title="Normalize dissimilar variables to 0-100% scale for trend alignment"
              >
                Normalized (0-100%)
              </button>
            </div>

            {/* Curve Style */}
            <select
              value={curveType}
              onChange={(e) => setCurveType(e.target.value as CurveType)}
              className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 font-semibold focus:outline-none"
            >
              <option value="monotone">Spline Smooth</option>
              <option value="linear">Linear</option>
              <option value="step">Step (Discrete)</option>
            </select>

            <button
              onClick={() => setShowAreaGradient(!showAreaGradient)}
              className={`p-1.5 rounded-lg border transition-all ${
                showAreaGradient ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'bg-slate-50 border-slate-200 text-slate-400'
              }`}
              title="Toggle Area Gradient Shading"
            >
              <Layers className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowGrid(!showGrid)}
              className={`p-1.5 rounded-lg border transition-all ${
                showGrid ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'bg-slate-50 border-slate-200 text-slate-400'
              }`}
              title="Toggle Cartesian Grid"
            >
              <Sliders className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT: SPLIT GRID - TAG BROWSER (LEFT) & MULTI-LINE TREND CHART (RIGHT) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* LEFT COLUMN: TAG SEARCH & SELECTOR (3 cols) */}
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/70">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-1.5 font-bold text-slate-800 text-sm">
                <Search className="w-4 h-4 text-indigo-600" />
                <span>Tag Selector ({selectedTagIds.length} / {gatewayTags.length})</span>
              </div>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                Max 8 Tags
              </span>
            </div>

            {/* Search Input */}
            <div className="relative mb-2.5">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search tag name, channel..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-7 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery('')} 
                  className="absolute right-2 top-2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Channel filter chips */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[10px] scrollbar-none">
              {channels.map(channel => (
                <button
                  key={channel}
                  onClick={() => setSelectedChannelFilter(channel)}
                  className={`px-2 py-0.5 rounded whitespace-nowrap font-medium transition-colors ${
                    selectedChannelFilter === channel
                      ? 'bg-slate-800 text-white'
                      : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {channel === 'All' ? 'All Channels' : channel.split('_')[0]}
                </button>
              ))}
            </div>
          </div>

          {/* Tags List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 max-h-[460px]">
            {filteredAvailableTags.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs">
                No matching tags found.
              </div>
            ) : (
              pagedTags.map(tag => {
                const isSelected = selectedTagIds.includes(tag.id);
                const tagColor = activeTags.find(t => t.id === tag.id)?.color;
                const isVisible = tagVisibility[tag.id] !== false;

                return (
                  <div
                    key={tag.id}
                    className={`p-3 flex items-center justify-between gap-3 transition-colors ${
                      isSelected ? 'bg-indigo-50/30' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div 
                      onClick={() => handleToggleTag(tag.id)}
                      className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer"
                    >
                      <div className="shrink-0 text-slate-400">
                        {isSelected ? (
                          <div 
                            className="w-4 h-4 rounded flex items-center justify-center text-white"
                            style={{ backgroundColor: tagColor }}
                          >
                            <Check className="w-3 h-3 stroke-[3]" />
                          </div>
                        ) : (
                          <Square className="w-4 h-4 text-slate-300 hover:text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-xs text-slate-800 truncate">{tag.name}</span>
                          {liveValues[tag.id] !== undefined && (
                            <span className="text-[10px] font-mono text-indigo-600 font-semibold">
                              ({typeof liveValues[tag.id].value === 'number' ? (liveValues[tag.id].value as number).toFixed(2) : String(liveValues[tag.id].value)})
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {tag.channelId} · {tag.dataType}
                        </div>
                      </div>
                    </div>

                    {/* Visibility eye toggle */}
                    {isSelected && (
                      <button
                        onClick={() => handleToggleVisibility(tag.id)}
                        className="p-1 text-slate-400 hover:text-indigo-600 rounded transition-colors shrink-0"
                        title={isVisible ? 'Hide from chart' : 'Show in chart'}
                      >
                        {isVisible ? <Eye className="w-3.5 h-3.5 text-indigo-600" /> : <EyeOff className="w-3.5 h-3.5 text-slate-300" />}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* 分页控件 */}
          <div className="px-3 py-2 border-t border-slate-100 bg-white flex items-center justify-between text-[11px]">
            <span className="font-mono text-slate-400">
              {t('hist.pagination', { n: filteredAvailableTags.length, page: safeTagPage + 1, total: tagTotalPages })}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setTagPage(safeTagPage - 1)}
                disabled={safeTagPage === 0}
                className="p-1 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setTagPage(safeTagPage + 1)}
                disabled={safeTagPage >= tagTotalPages - 1}
                className="p-1 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Active tags badges summary */}
          <div className="p-3 border-t border-slate-100 bg-slate-50 flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
            {activeTags.map(t => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold text-white shadow-xs"
                style={{ backgroundColor: t.color }}
              >
                <span className="truncate max-w-[120px]">{t.name}</span>
                <button
                  onClick={() => handleToggleTag(t.id)}
                  className="hover:opacity-80"
                  title="Remove from comparison"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: MULTI-TAG HISTORICAL CHART (8 cols) */}
        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-indigo-600" />
                Multi-Tag Synchronized Time Series Analysis
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {scalingMode === 'normalized' 
                  ? 'Normalized relative mode (0-100%) for cross-parameter physical correlation' 
                  : 'Direct engineering unit scaling'}
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs font-mono bg-slate-50 px-2.5 py-1 rounded border border-slate-200 text-slate-600">
              {isLoading ? (
                <span className="flex items-center gap-1.5 text-indigo-600">
                  <RefreshCw className="w-3 h-3 animate-spin" /> Querying TDengine…
                </span>
              ) : (
                <span>Points: {chartData.length}</span>
              )}
            </div>
          </div>

          {dataError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{t('hist.queryFailed', { error: dataError })}</span>
            </div>
          )}
          {!isLoading && !dataError && historyData && chartData.length === 0 && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-500">
              {t('hist.noData')}
            </div>
          )}

          {/* Recharts Container */}
          <div ref={chartContainerRef} className="h-[380px] w-full relative">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 25, bottom: 10, left: 10 }}>
                {/* SVG Gradients for Area Fills */}
                <defs>
                  {activeTags.map(tag => (
                    <linearGradient key={`grad_${tag.id}`} id={`grad_${tag.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={tag.color} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={tag.color} stopOpacity={0.0} />
                    </linearGradient>
                  ))}
                </defs>

                {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />}
                
                <XAxis 
                  dataKey="timestamp" 
                  stroke="#94a3b8" 
                  fontSize={11} 
                  tickLine={false} 
                  axisLine={{ stroke: '#cbd5e1' }}
                  minTickGap={40}
                />

                <YAxis 
                  stroke="#94a3b8" 
                  fontSize={11} 
                  tickLine={false} 
                  axisLine={{ stroke: '#cbd5e1' }}
                  unit={scalingMode === 'normalized' ? '%' : ''}
                  domain={scalingMode === 'normalized' ? [0, 100] : ['auto', 'auto']}
                  tickFormatter={(val) => Number(val).toFixed(scalingMode === 'normalized' ? 0 : 1)}
                />

                <Tooltip 
                  contentStyle={{ 
                    borderRadius: '10px', 
                    border: '1px solid #e2e8f0', 
                    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                    backgroundColor: '#ffffff',
                    fontSize: '12px',
                    padding: '10px 14px'
                  }}
                  labelStyle={{ fontWeight: 'bold', color: '#0f172a', marginBottom: '6px' }}
                  formatter={(value: any, name: any) => {
                    const tag = activeTags.find(t => t.id === name || `${t.id}_norm` === name);
                    if (!tag) return [value, name];
                    return [
                      scalingMode === 'normalized' 
                        ? `${Number(value).toFixed(1)}% (Raw ~${chartData.find(d => d[tag.id])?.[tag.id] ?? '-'} ${tag.unit})` 
                        : `${value} ${tag.unit}`,
                      tag.name
                    ];
                  }}
                />

                {/* Render Lines for each active tag */}
                {activeTags.map((tag) => {
                  const isVisible = tagVisibility[tag.id] !== false;
                  if (!isVisible) return null;

                  const dataKey = scalingMode === 'normalized' ? `${tag.id}_norm` : tag.id;

                  return (
                    <React.Fragment key={tag.id}>
                      {showAreaGradient && (
                        <Area
                          type={curveType}
                          dataKey={dataKey}
                          fill={`url(#grad_${tag.id})`}
                          stroke="none"
                          isAnimationActive={false}
                        />
                      )}
                      <Line 
                        type={curveType} 
                        dataKey={dataKey} 
                        name={tag.name}
                        stroke={tag.color} 
                        strokeWidth={2.2} 
                        dot={showDataPoints ? { r: 2.5, fill: tag.color } : false}
                        activeDot={{ r: 6, fill: tag.color, stroke: '#ffffff', strokeWidth: 2 }}
                        isAnimationActive={false}
                      />
                    </React.Fragment>
                  );
                })}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Interactive Chart Legend */}
          <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-center gap-4 text-xs">
            {activeTags.map(tag => {
              const isVisible = tagVisibility[tag.id] !== false;
              return (
                <button
                  key={tag.id}
                  onClick={() => handleToggleVisibility(tag.id)}
                  className={`flex items-center gap-2 px-2.5 py-1 rounded-md transition-all ${
                    isVisible ? 'bg-slate-100 text-slate-800 font-semibold' : 'text-slate-400 opacity-50 line-through'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: tag.color }}></span>
                  <span>{tag.name}</span>
                  <span className="text-[10px] font-mono text-slate-500">[{tag.unit || 'unit'}]</span>
                </button>
              );
            })}
          </div>
        </div>

      </div>

      {/* STATISTICAL SUMMARY TABLE FOR COMPARED TAGS */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-indigo-600" />
            <h4 className="font-bold text-slate-800 text-sm">Statistical Metrics & Engineering Envelope</h4>
          </div>
          <span className="text-xs text-slate-500 font-mono">
            Sample Window: {timePreset.toUpperCase()} · {historyData?.[0]?.intervalSec ? `${historyData[0].intervalSec}s buckets` : 'auto'} · {chartData.length} buckets
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-100/50 font-bold text-slate-600">
                <th className="py-3 px-4">Tag Name</th>
                <th className="py-3 px-4">Channel / Driver</th>
                <th className="py-3 px-4">Unit</th>
                <th className="py-3 px-4 text-right">Latest</th>
                <th className="py-3 px-4 text-right">Min</th>
                <th className="py-3 px-4 text-right">Max</th>
                <th className="py-3 px-4 text-right">Average (μ)</th>
                <th className="py-3 px-4 text-right">Std Dev (σ)</th>
                <th className="py-3 px-4 text-right">Delta (P-P)</th>
                <th className="py-3 px-4 text-center">Quality</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {tagStatistics.map(stat => {
                const tagMeta = activeTags.find(t => t.id === stat.tagId);
                const delta = Number((stat.max - stat.min).toFixed(2));

                return (
                  <tr key={stat.tagId} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-bold flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: stat.color }}></span>
                      <span className="font-mono text-slate-900">{stat.name}</span>
                    </td>
                    <td className="py-3 px-4 text-slate-500 font-mono text-[11px]">
                      {tagMeta?.channel || '-'}
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-600 font-mono">
                      {stat.unit || '-'}
                    </td>
                    <td className={`py-3 px-4 text-right font-mono font-bold ${stat.quality === 'Bad' ? 'text-slate-400' : 'text-indigo-600'}`}>
                      {stat.current}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-emerald-700">
                      {stat.min}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-rose-700">
                      {stat.max}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-slate-800">
                      {stat.avg}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-600">
                      ±{stat.stdDev}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-700">
                      {delta}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {stat.quality === 'Good' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                          <Check className="w-3 h-3" /> Good
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          stat.quality === 'Bad'
                            ? 'bg-rose-100 text-rose-800'
                            : stat.quality === 'Uncertain'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-500'
                        }`}>
                          {stat.quality === 'NoData' ? 'No Data' : stat.quality}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
