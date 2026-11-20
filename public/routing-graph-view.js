import { escapeHtml, relTime } from './app.js';

// Draws a routing graph (see routing-graph.js) as two columns of nodes joined by
// SVG curves. Read-only: clicks are handed to the callbacks, which open the
// rules view's existing forms, so the graph never talks to the API itself.

const CHANNEL_META = {
  forward: { name: '邮件转发', icon: '@', color: 'var(--accent)' },
  tg: { name: 'Telegram', icon: 'TG', color: 'var(--telegram)' },
  bark: { name: 'Bark', icon: 'B', color: 'var(--bark)' },
};
const SVG_NS = 'http://www.w3.org/2000/svg';

function sourceSub(source) {
  if (source.wildcard) return '与每个地址的专属规则同时生效';
  return source.lastReceivedAt ? `最近收信 ${relTime(source.lastReceivedAt)}` : '尚未收到邮件';
}

function renderSource(source) {
  const title = source.wildcard
    ? '* <span class="graph-node-domain">所有地址</span>'
    : `${escapeHtml(source.prefix)}<span class="graph-node-domain">@</span>`;
  return `<button type="button" class="graph-node graph-source" data-graph-source="${escapeHtml(source.prefix)}">
    <span class="graph-node-main">
      <span class="graph-node-title">${title}</span>
      <span class="graph-node-sub">${escapeHtml(sourceSub(source))}</span>
    </span>
    ${source.emailCount ? `<span class="graph-count" title="累计收到 ${source.emailCount} 封">${source.emailCount}</span>` : ''}
    <span class="graph-fan" title="送往 ${source.fanOut} 个出口">→ ${source.fanOut}</span>
    <span class="graph-port" aria-hidden="true"></span>
  </button>`;
}

function renderOutlet(outlet) {
  const meta = CHANNEL_META[outlet.channel];
  return `<button type="button" class="graph-node graph-outlet" data-graph-outlet="${escapeHtml(outlet.key)}">
    <span class="graph-port" aria-hidden="true"></span>
    <span class="graph-channel-icon graph-channel-${outlet.channel}" aria-hidden="true">${meta.icon}</span>
    <span class="graph-node-main">
      <span class="graph-node-title">${escapeHtml(outlet.label)}</span>
      <span class="graph-node-sub">${escapeHtml(outlet.detail)}</span>
    </span>
    ${outlet.fanIn > 1 ? `<span class="graph-fan" title="${outlet.fanIn} 个地址汇入">← ${outlet.fanIn}</span>` : ''}
  </button>`;
}

function renderOutlets(outlets) {
  if (!outlets.length) return '<p class="graph-empty-column">还没有出口，新建一条规则后会出现在这里</p>';
  return Object.keys(CHANNEL_META).map((channel) => {
    const group = outlets.filter((outlet) => outlet.channel === channel);
    if (!group.length) return '';
    return `<div class="graph-group-label graph-channel-${channel}">${CHANNEL_META[channel].name}</div>
      ${group.map(renderOutlet).join('')}`;
  }).join('');
}

function renderUnrouted(unrouted, open) {
  if (!unrouted.length) return '';
  return `<div class="graph-unrouted${open ? ' is-open' : ''}">
    <button type="button" class="graph-unrouted-toggle" data-graph-unrouted-toggle aria-expanded="${open}">
      <strong>未配置规则的地址 · ${unrouted.length}</strong>
      <small>邮件只存入收件箱，不会投递</small>
    </button>
    <div class="graph-unrouted-list"${open ? '' : ' hidden'}>
      ${unrouted.map((entry) => `<button type="button" data-graph-unrouted="${escapeHtml(entry.prefix)}" title="为 ${escapeHtml(entry.prefix)}@ 新建规则">${escapeHtml(entry.prefix)}<span>${entry.emailCount}</span></button>`).join('')}
    </div>
  </div>`;
}

export function mountRoutingGraph(container, { onEdge, onSource, onOutlet, onUnrouted }) {
  let graph = null;
  let unroutedOpen = false;

  const canvas = () => container.querySelector('.graph-canvas');
  const svg = () => container.querySelector('.graph-edges');

  function nodeOf(attribute, value) {
    return container.querySelector(`[${attribute}="${CSS.escape(value)}"]`);
  }

  // Edge geometry depends on the laid-out nodes, so it is recomputed whenever
  // the canvas resizes (including going from hidden to visible).
  function drawEdges() {
    const root = canvas();
    const layer = svg();
    if (!graph || !root || !layer) return;
    const box = root.getBoundingClientRect();
    layer.replaceChildren();
    for (const edge of graph.edges) {
      const from = nodeOf('data-graph-source', edge.prefix)?.getBoundingClientRect();
      const to = nodeOf('data-graph-outlet', edge.outletKey)?.getBoundingClientRect();
      if (!from || !to) continue;
      const ax = from.right - box.left + 4;
      const ay = from.top + from.height / 2 - box.top;
      const bx = to.left - box.left - 4;
      const by = to.top + to.height / 2 - box.top;
      const bend = Math.max(40, (bx - ax) / 2);
      const d = `M${ax},${ay} C${ax + bend},${ay} ${bx - bend},${by} ${bx},${by}`;

      const line = document.createElementNS(SVG_NS, 'path');
      line.setAttribute('d', d);
      line.setAttribute('class', `graph-edge graph-channel-${edge.channel}${edge.enabled ? '' : ' is-disabled'}`);
      line.dataset.edge = edge.ruleKey;
      // A wide transparent twin makes a 2px curve comfortable to hover and click.
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'graph-edge-hit');
      hit.dataset.graphEdge = edge.ruleKey;
      const tip = document.createElementNS(SVG_NS, 'title');
      tip.textContent = `${edge.prefix} → ${graph.outlets.find((o) => o.key === edge.outletKey)?.label || ''}${edge.enabled ? '' : '（已停用）'} · 点击编辑`;
      hit.append(tip);
      layer.append(line, hit);
    }
  }

  function highlight(edgeKeys) {
    const root = canvas();
    if (!root) return;
    if (!edgeKeys) {
      root.classList.remove('is-dimmed');
      root.querySelectorAll('.is-related').forEach((el) => el.classList.remove('is-related'));
      return;
    }
    const related = graph.edges.filter((edge) => edgeKeys.has(edge.ruleKey));
    const sources = new Set(related.map((edge) => edge.prefix));
    const outlets = new Set(related.map((edge) => edge.outletKey));
    root.classList.add('is-dimmed');
    root.querySelectorAll('[data-graph-source]').forEach((el) => el.classList.toggle('is-related', sources.has(el.dataset.graphSource)));
    root.querySelectorAll('[data-graph-outlet]').forEach((el) => el.classList.toggle('is-related', outlets.has(el.dataset.graphOutlet)));
    root.querySelectorAll('.graph-edge').forEach((el) => el.classList.toggle('is-related', edgeKeys.has(el.dataset.edge)));
  }

  function edgesTouching(target) {
    const source = target.closest('[data-graph-source]');
    if (source) return graph.edges.filter((edge) => edge.prefix === source.dataset.graphSource);
    const outlet = target.closest('[data-graph-outlet]');
    if (outlet) return graph.edges.filter((edge) => edge.outletKey === outlet.dataset.graphOutlet);
    const hit = target.closest('[data-graph-edge]');
    if (hit) return graph.edges.filter((edge) => edge.ruleKey === hit.dataset.graphEdge);
    return null;
  }

  function onPointer(event) {
    if (!graph) return;
    const edges = edgesTouching(event.target);
    highlight(edges ? new Set(edges.map((edge) => edge.ruleKey)) : null);
  }

  container.addEventListener('mouseover', onPointer);
  container.addEventListener('focusin', onPointer);
  container.addEventListener('mouseleave', () => highlight(null));
  container.addEventListener('focusout', (event) => {
    if (!container.contains(event.relatedTarget)) highlight(null);
  });

  container.addEventListener('click', (event) => {
    if (!graph) return;
    const unroutedToggle = event.target.closest('[data-graph-unrouted-toggle]');
    if (unroutedToggle) {
      unroutedOpen = !unroutedOpen;
      const wrap = unroutedToggle.closest('.graph-unrouted');
      wrap.classList.toggle('is-open', unroutedOpen);
      wrap.querySelector('.graph-unrouted-list').hidden = !unroutedOpen;
      unroutedToggle.setAttribute('aria-expanded', String(unroutedOpen));
      return;
    }
    const unrouted = event.target.closest('[data-graph-unrouted]');
    if (unrouted) {
      onUnrouted(unrouted.dataset.graphUnrouted);
      return;
    }
    const hit = event.target.closest('[data-graph-edge]');
    if (hit) {
      onEdge(hit.dataset.graphEdge);
      return;
    }
    const source = event.target.closest('[data-graph-source]');
    if (source) {
      onSource(source.dataset.graphSource);
      return;
    }
    const outlet = event.target.closest('[data-graph-outlet]');
    if (outlet) onOutlet(graph.outlets.find((entry) => entry.key === outlet.dataset.graphOutlet));
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => drawEdges()).observe(container);
  } else {
    window.addEventListener('resize', drawEdges);
  }

  function render(next) {
    graph = next;
    if (!graph) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `
      <div class="graph-legend" aria-hidden="true">
        <span><i class="graph-channel-forward"></i>邮件转发</span>
        <span><i class="graph-channel-tg"></i>Telegram</span>
        <span><i class="graph-channel-bark"></i>Bark</span>
        <span><i class="is-disabled"></i>已停用</span>
        <span class="graph-legend-hint">点击连线编辑规则，点击节点新建规则</span>
      </div>
      <div class="graph-canvas">
        <svg class="graph-edges" aria-hidden="true"></svg>
        <div class="graph-column graph-sources">
          <div class="graph-column-heading"><span>输入</span><strong>收件地址</strong></div>
          ${graph.sources.map(renderSource).join('')}
          ${renderUnrouted(graph.unrouted, unroutedOpen)}
        </div>
        <div class="graph-gutter" aria-hidden="true"></div>
        <div class="graph-column graph-outlets">
          <div class="graph-column-heading"><span>输出</span><strong>出口</strong></div>
          ${renderOutlets(graph.outlets)}
        </div>
      </div>`;
    drawEdges();
  }

  return { render, redraw: drawEdges };
}
