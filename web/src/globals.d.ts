// Types for `npm run typecheck:web` (tsconfig.web.json) only; nothing here reaches the bundle.

// Every element the app queries is an HTML or SVG element, and both carry dataset, tabIndex, focus/blur, style and the on*
// handlers (HTMLOrSVGElement, ElementCSSInlineStyle, GlobalEventHandlers). lib.dom leaves them off bare Element, which is
// what querySelector('.x') and closest('[data-x]') return; this puts them back so those results type-check.
interface Element extends HTMLOrSVGElement, ElementCSSInlineStyle, GlobalEventHandlers {}

// iOS Safari: true when the app runs from the home screen
interface Navigator { readonly standalone?: boolean }
