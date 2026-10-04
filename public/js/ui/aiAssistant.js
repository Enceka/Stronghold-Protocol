import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
import { useGameData } from './gameComponents.js';
import { useStore } from '../store.js';
import { net } from '../net.js';
import { actions } from './gameActions.js';
import { aiStateKey, checkAIConfig } from '../../../shared/ai.js';
import { aiAdviceStore, availableCoreBonds } from './aiAdvice.js';

const setAdvice = (message) => aiAdviceStore.set({ message });
const setOpen = (open) => aiAdviceStore.set({ open });

export function describeAIAction(a, gd, priv) {
  if (!a) return '当前无需操作';
  const pieces = [...(priv?.board || []), ...(priv?.hand || []), ...(priv?.temp || [])].filter(Boolean);
  const name = (id) => gd.chess(id)?.name || gd.item(id)?.name || gd.token(id)?.name || id;
  const unit = (uid) => { const p = pieces.find((x) => x.uid === uid); return p ? name(p.id) : `#${uid}`; };
  const dirs = { UP: '上', RIGHT: '右', DOWN: '下', LEFT: '左' };
  switch (a.t) {
    case 'g.infoReady': return '确认本局信息';
    case 'g.band': return `选择策略「${gd.band(a.bandId)?.name || a.bandId}」`;
    case 'g.bandSkip': return '跳过本次策略选择';
    case 'g.choice': return `选择第 ${a.idx + 1} 张机变卡`;
    case 'g.reward': return `领取第 ${a.idx + 1} 个奖励`;
    case 'g.buy': return `购买「${name(priv?.shop?.slots[a.slot]?.id || '')}」（商店第 ${a.slot + 1} 格）`;
    case 'g.refresh': return '刷新商店';
    case 'g.freeze': return priv?.shop?.frozen ? '解冻商店' : '冻结商店';
    case 'g.levelUp': return '升级商店';
    case 'g.sell': return `出售「${unit(a.uid)}」`;
    case 'g.move': return a.to.area === 'board' ? `将「${unit(a.uid)}」放到 (${a.to.row}, ${a.to.col})，朝${dirs[a.dir || 'RIGHT']}` : `将「${unit(a.uid)}」移到手牌第 ${a.to.idx + 1} 格`;
    case 'g.equip': return `为「${unit(a.targetUid)}」装备「${unit(a.itemUid)}」${a.replaceUid ? '，替换已有装备' : ''}`;
    case 'g.art': return `在 (${a.row}, ${a.col}) 使用「${unit(a.itemUid)}」，朝${dirs[a.dir || 'RIGHT']}`;
    case 'g.destroy': return `销毁「${unit(a.uid)}」`;
    case 'g.ready': return a.ready ? '完成休整，准备作战' : '取消准备';
    default: return a.t;
  }
}

const SAMPLE = { policy: 'preferences', preferredBands: ['band_bldsk'], preferredChess: [] };
const STORAGE_KEY = 'sp.ai.config.v1';
function initialConfig(config) {
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (checkAIConfig(saved)) return JSON.stringify(saved, null, 2); } catch { /* no saved preferences */ }
  return JSON.stringify(config || { policy: 'builtin' }, null, 2);
}

/** A player-facing entry to the same policy used by autoplay. All actions remain authoritative server intents. */
export function AIAssistant() {
  const pub = useStore((s) => s.match.public), priv = useStore((s) => s.match.private);
  const myId = useStore((s) => s.me.playerId);
  const gd = useGameData();
  const open = useStore((s) => s.open, Object.is, aiAdviceStore);
  const advice = useStore((s) => s.message, Object.is, aiAdviceStore);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => initialConfig(priv?.aiConfig)), [error, setError] = useState('');
  const [coreDraft, setCoreDraft] = useState(priv?.aiConfig?.coreBondId || '');
  const [sampleDraft, setSampleDraft] = useState(priv?.aiConfig?.search?.samples || 8);
  const seq = useRef(0), timeout = useRef(null), requested = useRef(null), lastRequest = useRef(0);
  const key = aiStateKey(pub, priv);
  const me = pub?.players?.find((p) => p.playerId === myId);
  useEffect(() => {
    const off = net.on('m.advice', (msg) => {
      if (msg.seq !== seq.current) return;
      clearTimeout(timeout.current); setBusy(false); setAdvice(msg);
    });
    return () => { off(); clearTimeout(timeout.current); setAdvice(null); setOpen(false); };
  }, []);
  const available = priv?.playerId === myId && priv?.alive && ['INFO_CHECK', 'BAND_DRAFT', 'SP_DRAFT', 'PREP'].includes(pub?.phase);
  useEffect(() => {
    if (!available) { setOpen(false); setAdvice(null); setBusy(false); clearTimeout(timeout.current); }
  }, [available]);
  const request = async (automatic = false) => {
    setBusy(true); setAdvice(null); setError('');
    requested.current = key; lastRequest.current = Date.now();
    const n = ++seq.current;
    timeout.current = setTimeout(() => { setBusy(false); setError('建议计算超时，请重试'); }, 15000);
    if (!await actions.advice(n, automatic ? { quiet: true } : {})) { clearTimeout(timeout.current); setBusy(false); setError('建议暂不可用，可点击重新计算'); }
  };
  useEffect(() => {
    if (!available || !priv?.aiConfig?.coreBondId || pub.phase !== 'PREP' || priv.ready || me?.autoplay || busy || requested.current === key) return;
    const timer = setTimeout(() => request(true), Math.max(300, 1100 - (Date.now() - lastRequest.current)));
    return () => clearTimeout(timer);
  }, [available, key, busy, me?.autoplay]);
  useEffect(() => { setCoreDraft(priv?.aiConfig?.coreBondId || ''); setSampleDraft(priv?.aiConfig?.search?.samples || 8); }, [priv?.aiConfig?.coreBondId, priv?.aiConfig?.search?.samples]);
  if (!available) return null;
  const stale = advice && (advice.stale || advice.stateKey !== key);
  const cores = availableCoreBonds(gd.list('bonds'), pub);
  const applyCore = async () => {
    const { coreBondId: oldCore, ...current } = priv.aiConfig || { policy: 'builtin' };
    void oldCore;
    const config = coreDraft ? { ...current, policy: 'search', coreBondId: coreDraft,
      search: { candidates: 4, rounds: 1, budgetMs: 5000, ...current.search, samples: Number(sampleDraft) } } : { ...current, policy: 'builtin' };
    if (await actions.aiConfig(config)) {
      setDraft(JSON.stringify(config, null, 2)); setAdvice(null); setError('');
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* applies for this match */ }
    }
  };
  const save = async () => {
    let config;
    try { config = JSON.parse(draft); } catch { setError('配置需要是有效的 JSON'); return; }
    if (!checkAIConfig(config)) { setError('请检查策略名称、偏好 ID、权重和搜索参数'); return; }
    if (await actions.aiConfig(config)) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* preferences still applied for this match */ }
      setError(''); setAdvice(null);
    }
  };
  return html`
    <div class="ai-launch"><${Button} variant="secondary" size="sm" icon="robot" onClick=${() => setOpen(true)} data-testid="ai-assistant-open">AI 助手<//></div>
    <${Modal} open=${open} onClose=${() => setOpen(false)} title="AI 助手" micro="DECISION ASSISTANT" class="ai-modal">
      <div class="ai-assistant" data-testid="ai-assistant">
        <div class="ai-core-controls">
          <label for="ai-core-bond">想玩的核心盟约</label>
          <select id="ai-core-bond" value=${coreDraft} onChange=${(e) => setCoreDraft(e.target.value)}>
            <option value="">自由构筑（不指定）</option>
            ${cores.map((b) => html`<option key=${b.bondId} value=${b.bondId} disabled=${b.unavailable}>${b.name}${b.unavailable ? '（本局禁用）' : ''}</option>`)}
          </select>
          <label for="ai-samples">模拟样本</label>
          <select id="ai-samples" value=${sampleDraft} onChange=${(e) => setSampleDraft(Number(e.target.value))}>
            ${[2, 4, 8, 16].map((n) => html`<option key=${n} value=${n}>${n} 个随机样本</option>`)}
          </select>
          <${Button} variant="primary" disabled=${busy} onClick=${applyCore}>应用构筑目标<//>
        </div>
        <p>${priv.aiConfig?.coreBondId ? `围绕【${gd.bond(priv.aiConfig.coreBondId)?.name || priv.aiConfig.coreBondId}】推荐；购买或刷新后自动重新模拟，推荐卡片会在商店闪烁标记。` : '先选择想玩的核心盟约，即可获得商店购买推荐与多样本模拟。'}</p>
        <div class="ai-assistant__buttons">
          <${Button} variant="primary" icon="search" loading=${busy} disabled=${busy || me?.autoplay} onClick=${() => request()}>获取建议<//>
          <${Button} variant="secondary" icon="robot" disabled=${busy} onClick=${async () => { if (await actions.autoplay(!me?.autoplay)) setOpen(false); }}>${me?.autoplay ? '停止托管' : '按当前配置托管'}<//>
        </div>
        ${advice ? html`<div class="ai-assistant__advice" role="status">
          <b>${stale ? '建议已过期，请重新获取' : describeAIAction(advice.action, gd, priv)}</b>
          <p>${advice.reason}</p>
          ${!stale && advice.shopRecommendations?.length ? html`<div class="ai-comparison">
            <p>实际完成 ${advice.search?.samples || 0}/${advice.search?.requestedSamples || 0} 个随机样本。存活比例描述接下来 ${advice.search?.rounds || 1} 回合的模拟结果。</p>
            <table><thead><tr><th>购买候选</th><th>平均收益</th><th>波动</th><th>存活</th></tr></thead><tbody>
              ${advice.shopRecommendations.map((r) => html`<tr key=${r.slot} class=${r.recommended ? 'is-recommended' : ''}>
                <td>${r.recommended ? '推荐 · ' : ''}${gd.chess(r.id)?.name || gd.item(r.id)?.name || r.id}${r.coreFit ? (gd.chess(r.id) ? ' · 核心成员' : ' · 核心装备') : ''}</td>
                <td>${r.samples ? r.score?.toFixed(1) : '未完成'}</td><td>${r.samples >= 2 ? `±${r.deviation?.toFixed(1)}` : '样本不足'}</td>
                <td>${r.samples ? `${r.alive}/${r.samples}` : '—'}</td>
              </tr>`)}
            </tbody></table>
          </div>` : null}
          <${Button} variant="primary" disabled=${stale || !advice.action || busy} onClick=${async () => {
            if (await actions.aiApply(advice.seq, advice.stateKey)) setAdvice(null);
            else setAdvice({ ...advice, stale: true });
          }}>执行这一步<//>
        </div>` : null}
        <details>
          <summary>设计 AI：偏好与搜索配置</summary>
          <p>内置策略 builtin；偏好策略 preferences；随机推演 search。填写干员与策略 ID，按数组顺序优先选择。搜索只能在有限计算预算内比较候选。</p>
          <label for="ai-config-json">AI 配置（JSON）</label>
          <textarea id="ai-config-json" value=${draft} onInput=${(e) => setDraft(e.target.value)} spellcheck="false" rows="8" />
          <div class="ai-assistant__buttons">
            <${Button} variant="primary" onClick=${save}>保存并应用到本局<//>
            <${Button} variant="secondary" onClick=${() => setDraft(JSON.stringify(SAMPLE, null, 2))}>偏好示例<//>
            <${Button} variant="secondary" onClick=${() => setDraft(JSON.stringify({ policy: 'search', search: { candidates: 3, samples: 2, rounds: 1, budgetMs: 200 } }, null, 2))}>推演示例<//>
          </div>
        </details>
        ${error ? html`<p role="alert" class="t-red">${error}</p>` : null}
      </div>
    <//>`;
}
