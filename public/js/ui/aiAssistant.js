import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
import { useGameData } from './gameComponents.js';
import { useStore } from '../store.js';
import { net } from '../net.js';
import { actions } from './gameActions.js';
import { aiStateKey, checkAIConfig } from '../../../shared/ai.js';

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
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [advice, setAdvice] = useState(null);
  const [draft, setDraft] = useState(() => initialConfig(priv?.aiConfig)), [error, setError] = useState('');
  const seq = useRef(0), timeout = useRef(null);
  const key = aiStateKey(pub, priv);
  const me = pub?.players?.find((p) => p.playerId === myId);
  useEffect(() => {
    const off = net.on('m.advice', (msg) => {
      if (msg.seq !== seq.current) return;
      clearTimeout(timeout.current); setBusy(false); setAdvice(msg);
    });
    return () => { off(); clearTimeout(timeout.current); };
  }, []);
  const available = priv?.playerId === myId && priv?.alive && ['INFO_CHECK', 'BAND_DRAFT', 'SP_DRAFT', 'PREP'].includes(pub?.phase);
  useEffect(() => {
    if (!available) { setOpen(false); setAdvice(null); setBusy(false); clearTimeout(timeout.current); }
  }, [available]);
  if (!available) return null;
  const stale = advice && (advice.stale || advice.stateKey !== key);
  const request = async () => {
    setBusy(true); setAdvice(null); setError('');
    const n = ++seq.current;
    timeout.current = setTimeout(() => { setBusy(false); setError('建议计算超时，请重试'); }, 8000);
    if (!await actions.advice(n)) { clearTimeout(timeout.current); setBusy(false); }
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
        <p>获取下一步建议，或让 AI 按你的配置托管。本局策略：${{ builtin: '内置 AI', preferences: '偏好策略', search: '随机推演' }[priv.aiConfig?.policy] || '内置 AI'}。</p>
        <div class="ai-assistant__buttons">
          <${Button} variant="primary" icon="search" loading=${busy} disabled=${busy || me?.autoplay} onClick=${request}>获取建议<//>
          <${Button} variant="secondary" icon="robot" disabled=${busy} onClick=${async () => { if (await actions.autoplay(!me?.autoplay)) setOpen(false); }}>${me?.autoplay ? '停止托管' : '按当前配置托管'}<//>
        </div>
        ${advice ? html`<div class="ai-assistant__advice" role="status">
          <b>${stale ? '建议已过期，请重新获取' : describeAIAction(advice.action, gd, priv)}</b>
          <p>${advice.reason}</p>
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
