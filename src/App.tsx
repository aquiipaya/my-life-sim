import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './index.css';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { SimulationEngine } from './simulationEngine';
import { CompareStats, SweepResult, SweepStatus, SweepPoint } from './types';

const App: React.FC = () => {
  // -----------------------
  // Base config (manual run)
  // -----------------------
  const [userConfig, setUserConfig] = useState({
    gridSize: 50,
    inflowRate: 5.0,
    consumptionRate: 1.5,
    diffusionSpeed: 0.1,
    diffusionCap: 0.8,
    initialAgents: 30,
    initialSpread: 15.0,
    seed: 12345
  });

  // Snapshot for controlled experiment
  const activeConfigRef = useRef({ ...userConfig });

  const [isPlaying, setIsPlaying] = useState(false);
  const [needsReset, setNeedsReset] = useState(false);
  const [chartData, setChartData] = useState<CompareStats[]>([]);

  const canvasRefs = {
    off: useRef<HTMLCanvasElement>(null),
    random: useRef<HTMLCanvasElement>(null),
    life: useRef<HTMLCanvasElement>(null),
  };
  const engines = useRef<{ [key: string]: SimulationEngine }>({});
  const tickRef = useRef(0);

  // RAF management
  const requestRef = useRef<number | null>(null);
  const stepRef = useRef<(() => void) | null>(null);

  // -----------------------
  // Sweep (phase diagram)
  // -----------------------
  const [isSweeping, setIsSweeping] = useState(false);
  const [renderDuringSweep, setRenderDuringSweep] = useState(false);
  const [sweepResults, setSweepResults] = useState<SweepResult[]>([]);
  const [sweepProgress, setSweepProgress] = useState({ done: 0, total: 0, label: '' });

  const [sweepInflowMin, setSweepInflowMin] = useState(1.0);
  const [sweepInflowMax, setSweepInflowMax] = useState(9.0);
  const [sweepConsMin, setSweepConsMin] = useState(0.5);
  const [sweepConsMax, setSweepConsMax] = useState(2.5);

  const SWEEP_TOTAL_TICKS = 650;
  const SWEEP_BURN_IN = 350;
  const SWEEP_MEASURE_TICKS = 250;

  const sweepQueueRef = useRef<SweepPoint[]>([]);
  const sweepIdxRef = useRef(0);
  const sweepTickRef = useRef(0);

  const accRef = useRef({
    n: 0,
    sumOff: 0,
    sumLife: 0,
    sumLifeDiff: 0,
    sumLifeAct: 0,
    sumAgentsLife: 0,
    sumAgentsRand: 0,
    errLifeMin: Number.POSITIVE_INFINITY,
    errLifeMax: Number.NEGATIVE_INFINITY,
  });

  const resetAcc = () => {
    accRef.current = {
      n: 0,
      sumOff: 0,
      sumLife: 0,
      sumLifeDiff: 0,
      sumLifeAct: 0,
      sumAgentsLife: 0,
      sumAgentsRand: 0,
      errLifeMin: Number.POSITIVE_INFINITY,
      errLifeMax: Number.NEGATIVE_INFINITY,
    };
  };

  const drawAll = useCallback(() => {
    if (!engines.current.off) return;
    const cOff = canvasRefs.off.current;
    const cRand = canvasRefs.random.current;
    const cLife = canvasRefs.life.current;
    if (!cOff || !cRand || !cLife) return;
    engines.current.off.draw(cOff, 'off');
    engines.current.random.draw(cRand, 'random');
    engines.current.life.draw(cLife, 'life');
  }, []);

  const stopRAF = () => {
    if (requestRef.current !== null) {
      cancelAnimationFrame(requestRef.current);
      requestRef.current = null;
    }
  };

  const hardStop = useCallback(() => {
    stopRAF();
    setIsPlaying(false);
  }, []);

  const handleReset = useCallback((override?: Partial<typeof userConfig>) => {
    stopRAF();
    setIsPlaying(false);

    const nextConfig = { ...userConfig, ...(override ?? {}) };
    activeConfigRef.current = { ...nextConfig };

    tickRef.current = 0;
    setChartData([]);
    setNeedsReset(false);

    engines.current = {
      off: new SimulationEngine(activeConfigRef.current),
      random: new SimulationEngine(activeConfigRef.current),
      life: new SimulationEngine(activeConfigRef.current),
    };
    const master = engines.current.off.generateMasterState(activeConfigRef.current);
    engines.current.off.importState(master, 'off');
    engines.current.random.importState(master, 'random');
    engines.current.life.importState(master, 'life');

    drawAll();
  }, [userConfig, drawAll]);

  useEffect(() => {
    handleReset();
  }, [handleReset]);

  const simulateManualStep = useCallback(() => {
    if (!isPlaying || !engines.current.off) return;

    const config = activeConfigRef.current;

    const sOff = engines.current.off.update({ ...config, mode: 'off' });
    const sRand = engines.current.random.update({ ...config, mode: 'random' });
    const sLife = engines.current.life.update({ ...config, mode: 'life' });

    drawAll();

    setChartData(prev => [
      ...prev.slice(-1000),
      {
        tick: tickRef.current,
        deltaHeat_off: sOff.deltaHeat,
        totalHeat_off: sOff.totalHeat,
        agent_off: sOff.agentCount ?? 0,
        heatDiff_off: sOff.heatDiff ?? sOff.deltaHeat ?? 0,
        heatAct_off: sOff.heatAct ?? 0,
        energyErr_off: sOff.energyError ?? 0,

        deltaHeat_random: sRand.deltaHeat,
        totalHeat_random: sRand.totalHeat,
        agent_random: sRand.agentCount ?? 0,
        heatDiff_random: sRand.heatDiff ?? 0,
        heatAct_random: sRand.heatAct ?? sRand.deltaHeat ?? 0,
        energyErr_random: sRand.energyError ?? 0,

        deltaHeat_life: sLife.deltaHeat,
        totalHeat_life: sLife.totalHeat,
        agent_life: sLife.agentCount ?? 0,
        heatDiff_life: sLife.heatDiff ?? 0,
        heatAct_life: sLife.heatAct ?? sLife.deltaHeat ?? 0,
        energyErr_life: sLife.energyError ?? 0,
      }
    ]);

    tickRef.current += 1;
    requestRef.current = requestAnimationFrame(() => stepRef.current?.());
  }, [isPlaying, drawAll]);

  const inflowList = useMemo(() => {
    const min = sweepInflowMin;
    const max = sweepInflowMax;
    const step = (max - min) / 4;
    return Array.from({ length: 5 }, (_, i) => +(min + step * i).toFixed(3));
  }, [sweepInflowMin, sweepInflowMax]);

  const consList = useMemo(() => {
    const min = sweepConsMin;
    const max = sweepConsMax;
    const step = (max - min) / 4;
    return Array.from({ length: 5 }, (_, i) => +(min + step * i).toFixed(3));
  }, [sweepConsMin, sweepConsMax]);

  const classify = (avgLife: number, avgOff: number, avgAgents: number): SweepStatus => {
    if (!Number.isFinite(avgLife) || !Number.isFinite(avgOff)) return 'invalid';
    if (avgAgents < 1) return 'dead';
    if (avgLife < avgOff) return 'suppressor';
    return 'accelerator';
  };

  const finalizeOneSweepPoint = (pt: SweepPoint) => {
    const acc = accRef.current;
    const n = acc.n || 1;

    const avgOff = acc.sumOff / n;
    const avgLife = acc.sumLife / n;
    const avgLifeDiff = acc.sumLifeDiff / n;
    const avgLifeAct = acc.sumLifeAct / n;
    const avgAgentsLife = acc.sumAgentsLife / n;
    const avgAgentsRand = acc.sumAgentsRand / n;

    const status = classify(avgLife, avgOff, avgAgentsLife);

    const result: SweepResult = {
      inflowRate: pt.inflowRate,
      consumptionRate: pt.consumptionRate,
      avg_delta_off: avgOff,
      avg_delta_life: avgLife,
      ratio_life_off: avgLife / (avgOff || 1e-9),
      avg_heatDiff_life: avgLifeDiff,
      avg_heatAct_life: avgLifeAct,
      avg_agents_life: avgAgentsLife,
      avg_agents_random: avgAgentsRand,
      energyErr_life_min: Number.isFinite(acc.errLifeMin) ? acc.errLifeMin : 0,
      energyErr_life_max: Number.isFinite(acc.errLifeMax) ? acc.errLifeMax : 0,
      status,
    };

    setSweepResults(prev => [...prev, result]);
  };

  const runNextSweepPoint = useCallback(() => {
    const q = sweepQueueRef.current;
    const idx = sweepIdxRef.current;

    if (idx >= q.length) {
      setIsSweeping(false);
      setSweepProgress(p => ({ ...p, label: 'DONE' }));
      hardStop();
      return;
    }

    const pt = q[idx];
    sweepIdxRef.current = idx + 1;
    sweepTickRef.current = 0;
    resetAcc();

    const override = {
      inflowRate: pt.inflowRate,
      consumptionRate: pt.consumptionRate,
    };

    setSweepProgress({ done: idx, total: q.length, label: `in=${pt.inflowRate.toFixed(2)}, met=${pt.consumptionRate.toFixed(2)}` });
    handleReset(override);
    setIsPlaying(true);
  }, [handleReset, hardStop]);

  const simulateSweepStep = useCallback(() => {
    if (!isPlaying || !isSweeping || !engines.current.off) return;

    const config = activeConfigRef.current;

    const sOff = engines.current.off.update({ ...config, mode: 'off' });
    const sRand = engines.current.random.update({ ...config, mode: 'random' });
    const sLife = engines.current.life.update({ ...config, mode: 'life' });

    if (renderDuringSweep) drawAll();

    const t = sweepTickRef.current;
    if (t >= SWEEP_BURN_IN) {
      const a = accRef.current;
      a.n += 1;
      a.sumOff += (sOff.deltaHeat ?? 0);
      a.sumLife += (sLife.deltaHeat ?? 0);
      a.sumLifeDiff += (sLife.heatDiff ?? 0);
      a.sumLifeAct += (sLife.heatAct ?? (sLife.deltaHeat ?? 0));
      a.sumAgentsLife += (sLife.agentCount ?? 0);
      a.sumAgentsRand += (sRand.agentCount ?? 0);

      const e = (sLife.energyError ?? 0);
      a.errLifeMin = Math.min(a.errLifeMin, e);
      a.errLifeMax = Math.max(a.errLifeMax, e);
    }

    if (t % 25 === 0) {
      setSweepProgress(p => ({
        ...p,
        done: p.done,
        total: p.total,
        label: `${p.label}  tick=${t}/${SWEEP_TOTAL_TICKS}`
      }));
    }

    sweepTickRef.current = t + 1;

    if (sweepTickRef.current >= SWEEP_TOTAL_TICKS) {
      setIsPlaying(false);
      const finishedPt = sweepQueueRef.current[sweepIdxRef.current - 1];
      finalizeOneSweepPoint(finishedPt);
      window.setTimeout(() => {
        runNextSweepPoint();
      }, 50);
      return;
    }

    requestRef.current = requestAnimationFrame(() => stepRef.current?.());
  }, [isPlaying, isSweeping, renderDuringSweep, drawAll, runNextSweepPoint]);

  const simulateStep = useCallback(() => {
    if (isSweeping) return simulateSweepStep();
    return simulateManualStep();
  }, [isSweeping, simulateSweepStep, simulateManualStep]);

  useEffect(() => {
    stepRef.current = simulateStep;
  }, [simulateStep]);

  useEffect(() => {
    if (isPlaying) {
      requestRef.current = requestAnimationFrame(() => stepRef.current?.());
    }
    return () => stopRAF();
  }, [isPlaying]);

  const updateParam = (key: string, val: number) => {
    setUserConfig(prev => ({ ...prev, [key]: val }));
    setNeedsReset(true);
  };

  const startSweep = () => {
    stopRAF();
    setIsPlaying(false);

    const points: SweepPoint[] = [];
    for (const c of consList) {
      for (const i of inflowList) {
        points.push({ inflowRate: i, consumptionRate: c });
      }
    }

    sweepQueueRef.current = points;
    sweepIdxRef.current = 0;
    setSweepResults([]);
    setIsSweeping(true);
    setSweepProgress({ done: 0, total: points.length, label: 'START' });

    runNextSweepPoint();
  };

  const stopSweep = () => {
    setIsSweeping(false);
    hardStop();
    setSweepProgress(p => ({ ...p, label: 'STOPPED' }));
  };

  const exportSweepCSV = () => {
    if (sweepResults.length === 0) return;

    const meta = {
      engine_version: 'SweepMode_v1',
      base_config: { ...userConfig },
      sweep: {
        inflow: inflowList,
        consumption: consList,
        totalTicks: SWEEP_TOTAL_TICKS,
        burnIn: SWEEP_BURN_IN,
        measureTicks: SWEEP_MEASURE_TICKS,
      },
      timestamp: new Date().toISOString(),
    };

    const headers = [
      'inflowRate', 'consumptionRate',
      'avg_delta_off', 'avg_delta_life', 'ratio_life_off',
      'avg_heatDiff_life', 'avg_heatAct_life',
      'avg_agents_life', 'avg_agents_random',
      'energyErr_life_min', 'energyErr_life_max',
      'status'
    ].join(',');

    const rows = sweepResults.map(r => [
      r.inflowRate, r.consumptionRate,
      r.avg_delta_off, r.avg_delta_life, r.ratio_life_off,
      r.avg_heatDiff_life, r.avg_heatAct_life,
      r.avg_agents_life, r.avg_agents_random,
      r.energyErr_life_min, r.energyErr_life_max,
      r.status
    ].join(','));

    const configLine = `# SweepMeta: ${JSON.stringify(meta)}`;
    const blob = new Blob([[configLine, headers, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `phase_sweep_${userConfig.seed}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 200);
  };

  const getCellColor = (status: SweepStatus) => {
    switch (status) {
      case 'suppressor': return '#2ecc71';
      case 'accelerator': return '#e74c3c';
      case 'dead': return '#95a5a6';
      case 'invalid': return '#7f8c8d';
      default: return '#7f8c8d';
    }
  };

  const gridMap = useMemo(() => {
    const map = new Map<string, SweepResult>();
    for (const r of sweepResults) {
      map.set(`${r.consumptionRate}|${r.inflowRate}`, r);
    }
    return map;
  }, [sweepResults]);

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-50 font-sans p-6 overflow-y-auto custom-scrollbar">
      <header className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-indigo-400">DISSIPATION RESEARCH SUITE <span className="text-xs font-mono opacity-50">Sweep Mode</span></h1>
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-mono mt-1">
          STATUS: {isSweeping ? `SWEEPING (${sweepProgress.done}/${sweepProgress.total})` : (isPlaying ? 'RUNNING' : 'IDLE')}
          {isSweeping ? ` | ${sweepProgress.label}` : ''}
        </div>
      </header>

      <div className="flex flex-wrap justify-center gap-6 mb-8">
        {(['off', 'random', 'life'] as const).map(m => (
          <div key={m} className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col items-center">
             <div className="w-full flex justify-between items-center mb-2">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border border-current bg-opacity-10 ${m === 'life' ? 'text-pink-500' : (m === 'random' ? 'text-amber-400' : 'text-sky-400')}`}>
                  ● {m.toUpperCase()}
                </span>
             </div>
             <div className="bg-black/40 rounded border border-slate-800/50 p-1">
                <canvas ref={canvasRefs[m]} width={220} height={220} className="w-full" />
             </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-6 flex flex-col">
          <div className="space-y-2">
            <button
              disabled={needsReset || isSweeping}
              onClick={() => setIsPlaying(v => !v)}
              className={`w-full py-3 rounded-md font-bold text-sm transition-all ${isSweeping ? 'bg-slate-800 text-slate-600' : (needsReset ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : (isPlaying ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'))}`}
            >
              {isSweeping ? 'SWEEP RUNNING' : (needsReset ? 'PARAM CHANGED' : (isPlaying ? 'STOP' : 'RUN MANUAL'))}
            </button>
            <button
              onClick={() => handleReset()}
              disabled={isSweeping}
              className={`w-full py-2 rounded-md font-bold text-xs transition-all border ${isSweeping ? 'bg-slate-800 text-slate-600 border-slate-700' : (needsReset ? 'bg-amber-500 text-slate-950 border-amber-400 hover:bg-amber-400' : 'bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700')}`}
            >
              {needsReset ? 'APPLY & RESET' : 'RESET ENGINE'}
            </button>
          </div>

          <div className="space-y-4 pt-4 border-t border-slate-800">
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <span>Grid Size</span>
                <span>{userConfig.gridSize}u</span>
              </div>
              <input type="range" min="20" max="100" step="10" value={userConfig.gridSize} onChange={e => updateParam('gridSize', Number(e.target.value))} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
            </div>

            <div className="space-y-1">
               <div className="flex justify-between text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                  <span>Seed Identity</span>
               </div>
               <input type="number" value={userConfig.seed} onChange={e => updateParam('seed', Number(e.target.value))} className="w-full bg-slate-800 text-slate-200 text-xs font-mono border border-slate-700 p-2 rounded focus:outline-none focus:border-indigo-500" />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <span>Initial Reservoir</span>
                <span>{userConfig.initialSpread.toFixed(0)}%</span>
              </div>
              <input type="range" min="1" max="40" step="1" value={userConfig.initialSpread} onChange={e => updateParam('initialSpread', Number(e.target.value))} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <span>Diffusion Speed</span>
                <span>{userConfig.diffusionSpeed.toFixed(2)}</span>
              </div>
              <input type="range" min="0" max="0.3" step="0.01" value={userConfig.diffusionSpeed} onChange={e => updateParam('diffusionSpeed', Number(e.target.value))} className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
            </div>
          </div>

          <div className="space-y-4 pt-6 border-t border-slate-800">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Phase Sweep Config</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 font-mono">Inflow Min</span>
                <input type="number" step="0.1" value={sweepInflowMin} onChange={e => setSweepInflowMin(Number(e.target.value))} disabled={isSweeping} className="w-full bg-slate-800 text-slate-200 text-xs p-2 rounded border border-slate-700" />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 font-mono">Inflow Max</span>
                <input type="number" step="0.1" value={sweepInflowMax} onChange={e => setSweepInflowMax(Number(e.target.value))} disabled={isSweeping} className="w-full bg-slate-800 text-slate-200 text-xs p-2 rounded border border-slate-700" />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 font-mono">Cons Min</span>
                <input type="number" step="0.1" value={sweepConsMin} onChange={e => setSweepConsMin(Number(e.target.value))} disabled={isSweeping} className="w-full bg-slate-800 text-slate-200 text-xs p-2 rounded border border-slate-700" />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 font-mono">Cons Max</span>
                <input type="number" step="0.1" value={sweepConsMax} onChange={e => setSweepConsMax(Number(e.target.value))} disabled={isSweeping} className="w-full bg-slate-800 text-slate-200 text-xs p-2 rounded border border-slate-700" />
              </div>
            </div>

            <label className="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer">
              <input type="checkbox" checked={renderDuringSweep} onChange={e => setRenderDuringSweep(e.target.checked)} disabled={isSweeping && isPlaying} className="rounded border-slate-700 bg-slate-800 text-indigo-500" />
              <span>Real-time Rendering</span>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={startSweep} disabled={isSweeping} className={`py-2 rounded font-bold text-xs transition-colors ${isSweeping ? 'bg-slate-800 text-slate-600' : 'bg-indigo-600 hover:bg-indigo-500'}`}>START SWEEP</button>
              <button onClick={stopSweep} disabled={!isSweeping} className={`py-2 rounded font-bold text-xs transition-colors ${!isSweeping ? 'bg-slate-800 text-slate-600' : 'bg-rose-700 hover:bg-rose-600'}`}>STOP</button>
            </div>
            <button onClick={exportSweepCSV} disabled={sweepResults.length === 0} className={`w-full py-2 rounded font-bold text-xs border ${sweepResults.length === 0 ? 'bg-slate-800 text-slate-600 border-slate-700' : 'bg-indigo-950 text-indigo-400 border-indigo-500/50 hover:bg-indigo-900'}`}>EXPORT PHASE DATA (.CSV)</button>
          </div>
        </div>

        <div className="lg:col-span-3 space-y-6 overflow-hidden flex flex-col">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 flex flex-col h-[400px]">
            <h3 className="text-sm font-bold text-slate-300 mb-4 font-mono">TIME SERIES (Manual Run Audit)</h3>
            <div className="flex-1 min-h-0 bg-black/20 rounded border border-slate-800/50 p-2">
               <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="tick" hide />
                    <YAxis stroke="#475569" fontSize={10} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '4px', fontSize: '10px' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
                    <Line type="monotone" dataKey="deltaHeat_off" stroke="#38bdf8" name="OFF deltaHeat" dot={false} strokeWidth={2} isAnimationActive={false} />
                    <Line type="monotone" dataKey="deltaHeat_random" stroke="#fbbf24" name="RAND deltaHeat" dot={false} strokeWidth={2} isAnimationActive={false} />
                    <Line type="monotone" dataKey="deltaHeat_life" stroke="#f472b6" name="LIFE deltaHeat" dot={false} strokeWidth={2} isAnimationActive={false} />
                  </LineChart>
               </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 flex flex-col overflow-hidden">
             <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold text-slate-300 font-mono">PHASE DIAGRAM (MEPP Signature Analysis)</h3>
                <div className="flex gap-4 text-[9px] font-mono">
                  {/* Using string literals to prevent comparison symbols from being parsed as JSX tags */}
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#2ecc71]"></span> Suppressor {'(L < O)'}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#e74c3c]"></span> Accelerator {'(L ≥ O)'}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#95a5a6]"></span> Extinct {'(A < 1)'}</span>
                </div>
             </div>

             <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full border-collapse min-w-[500px]">
                   <thead>
                      <tr>
                        <th className="text-[10px] text-slate-500 font-mono text-left p-2 border-b border-slate-800 lowercase tracking-tighter">metabolism \\ inflow</th>
                        {inflowList.map(v => (
                          <th key={v} className="p-2 border-b border-slate-800 text-[10px] font-mono text-slate-400 text-center">{v.toFixed(2)}</th>
                        ))}
                      </tr>
                   </thead>
                   <tbody>
                      {consList.map(c => (
                        <tr key={c}>
                          <td className="p-2 border-b border-slate-800 text-[10px] font-mono text-slate-400">{c.toFixed(2)}</td>
                          {inflowList.map(i => {
                            const r = gridMap.get(`${c}|${i}`);
                            const status: SweepStatus = r?.status ?? 'invalid';
                            const bg = r ? getCellColor(status) : '#020617';
                            const content = r ? (
                              <div className="flex flex-col items-center">
                                <span className="font-bold">{(r.ratio_life_off).toFixed(2)}</span>
                                <span className="text-[8px] opacity-70">A:{r.avg_agents_life.toFixed(1)}</span>
                              </div>
                            ) : '—';
                            return (
                              <td
                                key={`${c}-${i}`}
                                style={{ backgroundColor: bg }}
                                className="p-2 border border-slate-950 text-slate-900 text-[10px] font-mono text-center h-10 transition-colors"
                              >
                                {content}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                   </tbody>
                </table>
             </div>
             <div className="mt-4 text-[9px] text-slate-500 font-mono italic">
               * Values indicate Life/Off Dissipation Ratio. Green region shows "Homeostatic Suppressor" behavior. Red region shows "Dissipative Accelerator" signature.
             </div>
          </div>
        </div>
      </div>

      <footer className="mt-8 pt-4 border-t border-slate-800 flex justify-between text-[10px] text-slate-600 font-mono uppercase tracking-widest">
         <span>MEPP Phase Research Module</span>
         <span>Energy Conservation: Active</span>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #020617; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #334155; }
      `}</style>
    </div>
  );
};

export default App;