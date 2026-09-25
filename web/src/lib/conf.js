// Confidence badges (approved mockup mockups/r-learning.html; design docs/audit-designs/learning-layer.md §2 and §11).
// A chip is drawn only from a tier the API sent: `conf` on /api/profile, /api/appliances/pool and /api/appliances/ac, or a
// model row of the owner's /api/models. No tier, no chip. The owner's model row supplies the text ("±11%", "learning · 3 of 14");
// a guest (no /api/models) sees the tier word.
export const TIERS = { measured: 'm', learned: 'l', estimated: 'e', learning: 'n', unscored: 'u' };

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The owner's model row for `id` from /api/models, or null. */
export const modelOf = (models, id) => models?.models?.find(m => m.id === id) ?? null;

/** Chip text for a tier: the model's own badge text when the report agrees on the tier, else the tier word; null for no tier. */
export function confText(tier, model) {
  if (!Object.hasOwn(TIERS, tier ?? '')) return null;
  return model && model.tier === tier && model.v ? model.v : tier;
}

/** `<span class="conf" data-t="l">±11%</span>`, or '' when the API gave no (known) tier. */
export function confChip(tier, model, style = '') {
  const text = confText(tier, model);
  return text == null ? '' : `<span class="conf" data-t="${TIERS[tier]}"${style ? ` style="${style}"` : ''}>${esc(text)}</span>`;
}

/** The Next 48 hours header ("forecast · solar ±11% · home ±14% · battery ±5 pts at 6 h") from /api/profile's conf;
 *  null when the profile carried no conf (the header keeps its own text). */
export function fc48Header(conf, models) {
  if (!conf) return null;
  const part = (label, id) => {
    const tier = conf[id], m = modelOf(models, id), text = confText(tier, m); if (text == null) return null;
    // the battery reads its 1–6 h band when the owner's report has one ("±5 pts at 6 h")
    if (id === 'fc48.soc' && m?.tier === tier && (tier === 'learned' || tier === 'estimated') && m.bands?.['h1-6'] != null) return `${label} ±${m.bands['h1-6']} pts at 6 h`;
    return `${label} ${text}`;
  };
  const parts = [part('solar', 'fc48.solar'), part('home', 'fc48.home'), part('battery', 'fc48.soc')].filter(Boolean);
  return parts.length ? `forecast · ${parts.join(' · ')}` : null;
}

/** Bias direction for the report's arrow: over-predicting (up), under (dn) or even (ev); null without a bias. */
export const biasDir = b => b == null ? null : b > 1 ? 'up' : b < -1 ? 'dn' : 'ev';

/** The 8-week error sparkline (lower is better), bars brightening toward this week. '' without values. */
export function sparkline(values, w = 58, h = 18) {
  if (!values?.length) return '';
  const max = Math.max(...values), bw = (w - (values.length - 1) * 1.5) / values.length;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${values.map((v, i) => { const bh = Math.max(1, v / (max || 1) * h), x = i * (bw + 1.5);
    return `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="rgba(78,240,166,${(.35 + .55 * (values.length > 1 ? i / (values.length - 1) : 1)).toFixed(2)})"/>`; }).join('')}</svg>`;
}
