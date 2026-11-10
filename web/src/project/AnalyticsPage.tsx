import { useEffect, useState } from 'react';
import { api } from '../api';
import { useProject } from './store';
import { ErrorText, Spinner } from '../components/ui';
import { shortDate } from '../util';

interface IterationStat {
  number: number;
  start: string;
  finish: string;
  scope: string;
  team_strength: number;
  points_accepted: number;
  rolling_velocity: number;
  cumulative_points_accepted: number;
  scope_points: number;
  stories_accepted: number;
  features_accepted: number;
  bugs_accepted: number;
  chores_accepted: number;
  rejections: number;
  avg_cycle_time_hours: number | null;
}
interface Analytics {
  velocity: number;
  current_iteration_number: number;
  iterations: IterationStat[];
  current: { points_total: number; points_accepted: number; state_counts: Record<string, number>; state_points: Record<string, number> };
  backlog_points: number;
  icebox_points: number;
  unestimated_features: number;
  cycle_times: { story_id: number; name: string; story_type: string; estimate: number | null; accepted_at: string; hours: number }[];
}

// Categorical slots 1–3 of the validated reference palette (pass all-pairs CVD checks in light mode).
const S1 = '#2a78d6';
const S2 = '#eb6834';
const S3 = '#1baf7a';

export function AnalyticsPage() {
  const p = useProject();
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [range, setRange] = useState(12);
  useEffect(() => {
    api.get<Analytics>(`/projects/${p.projectId}/analytics?iterations=${range}`).then(setData).catch(setError);
  }, [p.projectId, range, p.version]);
  if (error) return <div className="page"><ErrorText error={error} /></div>;
  if (!data) return <div className="center-page"><Spinner /></div>;

  const its = data.iterations;
  const cur = data.current;
  const done = its.filter((i) => i.scope === 'done');
  const avgCycle = done.flatMap((i) => (i.avg_cycle_time_hours != null ? [i.avg_cycle_time_hours] : []));
  const remainingIterations = data.velocity ? Math.ceil(data.backlog_points / data.velocity) : null;

  return (
    <div className="page analytics-page">
      <div className="row gap filters">
        <label className="row gap small">
          Show last
          <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
            {[6, 12, 26, 52].map((n) => (
              <option key={n} value={n}>
                {n} iterations
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stat-tiles">
        <Stat label="Velocity" value={data.velocity} sub="points / iteration" />
        <Stat label="Current iteration" value={`${cur.points_accepted} / ${cur.points_total}`} sub="points accepted" />
        <Stat label="Backlog" value={data.backlog_points} sub={remainingIterations != null ? `≈ ${remainingIterations} iteration${remainingIterations === 1 ? '' : 's'} of work` : 'points'} />
        <Stat label="Icebox" value={data.icebox_points} sub="points" />
        <Stat label="Unestimated features" value={data.unestimated_features} sub="not yet accepted" />
        <Stat
          label="Avg cycle time"
          value={avgCycle.length ? formatHours(avgCycle.reduce((a, b) => a + b, 0) / avgCycle.length) : '—'}
          sub="started → accepted"
        />
      </div>

      <div className="charts">
        <ChartCard title="Velocity" legend={[{ color: S1, label: 'Points accepted', kind: 'bar' }, { color: S2, label: 'Rolling velocity', kind: 'line' }]}>
          <BarLineChart
            labels={its.map((i) => String(i.number))}
            bars={[{ color: S1, values: its.map((i) => i.points_accepted), name: 'Points accepted' }]}
            line={{ color: S2, values: its.map((i) => i.rolling_velocity), name: 'Rolling velocity' }}
            tooltipTitle={(k) => `Iteration ${its[k].number} · ${shortDate(its[k].start)}${its[k].scope === 'current' ? ' (current)' : ''}`}
          />
        </ChartCard>

        <ChartCard title="Burn-up" legend={[{ color: S1, label: 'Accepted (cumulative)', kind: 'line' }, { color: S2, label: 'Scope', kind: 'line' }]}>
          <BarLineChart
            labels={its.map((i) => String(i.number))}
            lines={[
              { color: S2, values: its.map((i) => i.scope_points), name: 'Scope' },
              { color: S1, values: its.map((i) => i.cumulative_points_accepted), name: 'Accepted' },
            ]}
            tooltipTitle={(k) => `Iteration ${its[k].number} · ${shortDate(its[k].start)}`}
          />
        </ChartCard>

        <ChartCard
          title="Stories accepted by type"
          legend={[
            { color: S1, label: 'Features', kind: 'bar' },
            { color: S2, label: 'Bugs', kind: 'bar' },
            { color: S3, label: 'Chores', kind: 'bar' },
          ]}
        >
          <BarLineChart
            labels={its.map((i) => String(i.number))}
            stacked
            bars={[
              { color: S1, values: its.map((i) => i.features_accepted), name: 'Features' },
              { color: S2, values: its.map((i) => i.bugs_accepted), name: 'Bugs' },
              { color: S3, values: its.map((i) => i.chores_accepted), name: 'Chores' },
            ]}
            tooltipTitle={(k) => `Iteration ${its[k].number}`}
          />
        </ChartCard>

        <ChartCard title="Current iteration by state">
          <StateBreakdown counts={cur.state_counts} points={cur.state_points} />
        </ChartCard>
      </div>

      <div className="card">
        <h2>Iterations</h2>
        <div className="table-scroll">
          <table className="table numeric">
            <thead>
              <tr>
                <th>#</th>
                <th>Start</th>
                <th>Strength</th>
                <th>Points</th>
                <th>Velocity</th>
                <th>Stories</th>
                <th>Features</th>
                <th>Bugs</th>
                <th>Chores</th>
                <th>Rejections</th>
                <th>Avg cycle</th>
              </tr>
            </thead>
            <tbody>
              {[...its].reverse().map((i) => (
                <tr key={i.number}>
                  <td>
                    {i.number}
                    {i.scope === 'current' && <span className="tag small">current</span>}
                  </td>
                  <td>{shortDate(i.start)}</td>
                  <td>{Math.round(i.team_strength * 100)}%</td>
                  <td>{i.points_accepted}</td>
                  <td>{i.rolling_velocity}</td>
                  <td>{i.stories_accepted}</td>
                  <td>{i.features_accepted}</td>
                  <td>{i.bugs_accepted}</td>
                  <td>{i.chores_accepted}</td>
                  <td>{i.rejections}</td>
                  <td>{i.avg_cycle_time_hours != null ? formatHours(i.avg_cycle_time_hours) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Cycle time (recently accepted)</h2>
        {data.cycle_times.length === 0 ? (
          <p className="muted">Accept some started stories to see cycle times.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Story</th>
                  <th>Type</th>
                  <th>Points</th>
                  <th>Accepted</th>
                  <th>Cycle time</th>
                </tr>
              </thead>
              <tbody>
                {data.cycle_times.slice(0, 30).map((c) => (
                  <tr key={c.story_id}>
                    <td>
                      <a href={`/projects/${p.projectId}/stories/${c.story_id}`}>#{c.story_id}</a> {c.name}
                    </td>
                    <td>{c.story_type}</td>
                    <td>{c.estimate ?? '—'}</td>
                    <td>{shortDate(c.accepted_at)}</td>
                    <td>{formatHours(c.hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function formatHours(h: number) {
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round((h / 24) * 10) / 10}d`;
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, legend, children }: { title: string; legend?: { color: string; label: string; kind: 'bar' | 'line' }[]; children: React.ReactNode }) {
  return (
    <div className="card chart-card">
      <h3>{title}</h3>
      {legend && (
        <div className="legend">
          {legend.map((l) => (
            <span key={l.label} className="legend-item">
              <span className={`legend-swatch ${l.kind}`} style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

interface Series {
  color: string;
  values: number[];
  name: string;
}

/** Minimal single-axis bar/line chart with hover tooltip. */
function BarLineChart({
  labels,
  bars = [],
  line,
  lines = [],
  stacked,
  tooltipTitle,
}: {
  labels: string[];
  bars?: Series[];
  line?: Series;
  lines?: Series[];
  stacked?: boolean;
  tooltipTitle: (i: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const allLines = line ? [...lines, line] : lines;
  const W = 560;
  const H = 220;
  const m = { l: 36, r: 8, t: 10, b: 24 };
  const n = labels.length;
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const barMax = stacked ? Math.max(0, ...labels.map((_, i) => bars.reduce((s, b) => s + b.values[i], 0))) : Math.max(0, ...bars.flatMap((b) => b.values));
  const max = niceMax(Math.max(barMax, ...allLines.flatMap((l) => l.values), 1));
  const step = iw / Math.max(n, 1);
  const x = (i: number) => m.l + step * i + step / 2;
  const y = (v: number) => m.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const groupW = Math.min(step * 0.7, 36);
  const barW = stacked ? groupW : Math.max(2, (groupW - 2 * (bars.length - 1)) / Math.max(bars.length, 1));

  if (n === 0) return <p className="muted">No iterations yet.</p>;

  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={m.l - 6} y={y(t) + 4} textAnchor="end" className="axis-text">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          n <= 16 || i % Math.ceil(n / 16) === 0 ? (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="axis-text">
              {l}
            </text>
          ) : null,
        )}
        {hover != null && <rect x={x(hover) - step / 2} y={m.t} width={step} height={ih} className="hover-band" />}
        {labels.map((_, i) => {
          let acc = 0;
          return bars.map((b, k) => {
            const v = b.values[i];
            if (!v) return null;
            const x0 = stacked ? x(i) - groupW / 2 : x(i) - groupW / 2 + k * (barW + 2);
            const top = stacked ? y(acc + v) : y(v);
            const bottom = stacked ? y(acc) : y(0);
            acc += v;
            const h = Math.max(0, bottom - top - (stacked && acc - v > 0 ? 2 : 0));
            return <path key={`${i}-${k}`} d={roundedTop(x0, top, barW, h, stacked && k < bars.length - 1 ? 0 : Math.min(4, barW / 2))} fill={b.color} />;
          });
        })}
        {allLines.map((l) => (
          <g key={l.name}>
            <polyline fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" points={l.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {l.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4.5 : 3} fill={l.color} stroke="#fff" strokeWidth={2} />
            ))}
          </g>
        ))}
        {labels.map((_, i) => (
          <rect key={i} x={x(i) - step / 2} y={m.t} width={step} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover != null && (
        <div className="chart-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <div className="tt-title">{tooltipTitle(hover)}</div>
          {[...bars, ...allLines].map((s) => (
            <div key={s.name} className="tt-row">
              <span className="legend-swatch" style={{ background: s.color }} />
              {s.name}
              <b>{s.values[hover]}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return '';
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

const STATE_ORDER = ['accepted', 'delivered', 'finished', 'started', 'rejected', 'unstarted'];

function StateBreakdown({ counts, points }: { counts: Record<string, number>; points: Record<string, number> }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return <p className="muted">Nothing in the current iteration yet.</p>;
  return (
    <table className="table state-table">
      <tbody>
        {STATE_ORDER.filter((s) => counts[s]).map((s) => (
          <tr key={s}>
            <td>
              <span className={`state-dot state-${s}`} /> {s}
            </td>
            <td className="num">{counts[s]} stories</td>
            <td className="num">{points[s] ?? 0} pts</td>
            <td style={{ width: '40%' }}>
              <div className="bar">
                <div className="bar-done" style={{ width: `${(counts[s] / total) * 100}%` }} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
