import { editorInfoField } from 'obsidian';
import { StateEffect, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import * as Y from 'yjs';
import { getShareSync, onShareSyncChange, parseFrontmatter } from '../session/sessions';

const refreshCursors = StateEffect.define<null>();
const colors = ['#397b63', '#9361a8', '#386db0', '#a56a24', '#ad526a', '#397f8b'];

class Caret extends WidgetType {
  constructor(readonly color: string, readonly name: string) { super(); }
  eq(other: Caret) { return other.color === this.color && other.name === this.name; }
  toDOM(view: EditorView) {
    const caret = view.dom.ownerDocument.createElement('span');
    caret.style.cssText = `border-left:2px solid ${this.color};position:relative;margin-left:-1px;pointer-events:none`;
    caret.setAttribute('aria-label', `${this.name}'s cursor`);
    const label = caret.appendChild(view.dom.ownerDocument.createElement('span'));
    label.textContent = this.name;
    label.style.cssText = `position:absolute;bottom:100%;left:-2px;background:${this.color};color:white;font:11px/1.5 sans-serif;padding:0 4px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis`;
    return caret;
  }
}

/** Cursors follow Yjs positions, without adding a second document-writing binding. */
export function liveCursors(username: () => string) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    sync: ReturnType<typeof getShareSync>;
    frame: number | null = null;
    unsubscribe: () => void;
    lastCursor = '';
    lastUser = '';
    constructor(readonly view: EditorView) {
      this.unsubscribe = onShareSyncChange(this.schedule);
      this.refresh();
    }
    schedule = () => {
      if (this.frame !== null) return;
      this.frame = (this.view.dom.ownerDocument.defaultView || window).requestAnimationFrame(() => {
        this.frame = null;
        this.view.dispatch({ effects: refreshCursors.of(null) });
      });
    };
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged || update.transactions.some((tx) => tx.effects.some((effect) => effect.is(refreshCursors)))) this.refresh();
    }
    refresh() {
      const path = this.view.state.field(editorInfoField, false)?.file?.path;
      const next = path ? getShareSync(path) : undefined;
      if (next !== this.sync) {
        this.sync?.provider.awareness.setLocalStateField('cursor', null);
        this.sync?.provider.awareness.off('change', this.schedule);
        this.sync = next;
        this.lastCursor = '';
        this.lastUser = '';
        this.sync?.provider.awareness.on('change', this.schedule);
      }
      const sync = this.sync;
      this.decorations = Decoration.none;
      if (!sync) return;
      const source = this.view.state.doc.toString();
      const { body } = parseFrontmatter(source);
      const offset = source.length - body.length;
      const text = sync.doc.getText('content');
      const awareness = sync.provider.awareness;
      // The vault bridge is asynchronous. Never display or send positions against
      // a different text version, especially while remote edits reach the editor.
      if (body !== text.toString()) {
        if (this.lastCursor !== 'null') {
          awareness.setLocalStateField('cursor', null);
          this.lastCursor = 'null';
        }
        return;
      }
      const selection = this.view.state.selection.main;
      const focused = this.view.hasFocus && this.view.dom.ownerDocument.hasFocus();
      const cursor = focused && selection.anchor >= offset && selection.head >= offset ? {
        anchor: Y.createRelativePositionFromTypeIndex(text, selection.anchor - offset),
        head: Y.createRelativePositionFromTypeIndex(text, selection.head - offset),
      } : null;
      const encoded = JSON.stringify(cursor);
      const name = username().trim().slice(0, 40) || 'Participant';
      if (encoded !== this.lastCursor || name !== this.lastUser) {
        this.lastCursor = encoded;
        this.lastUser = name;
        const color = colors[awareness.clientID % colors.length];
        awareness.setLocalStateField('user', { name, color, colorLight: `${color}33` });
        awareness.setLocalStateField('cursor', cursor);
      }
      const marks: Range<Decoration>[] = [];
      for (const [client, state] of awareness.getStates()) {
        if (client === awareness.clientID || !state.cursor) continue;
        try {
          const anchor = Y.createAbsolutePositionFromRelativePosition(state.cursor.anchor, sync.doc);
          const head = Y.createAbsolutePositionFromRelativePosition(state.cursor.head, sync.doc);
          if (!anchor || !head || anchor.type !== text || head.type !== text) continue;
          const from = Math.min(anchor.index, head.index) + offset;
          const to = Math.max(anchor.index, head.index) + offset;
          if (from < offset || to > source.length) continue;
          const color = colors[client % colors.length];
          const name = typeof state.user?.name === 'string' ? state.user.name.slice(0, 40) : 'Participant';
          if (from !== to) marks.push(Decoration.mark({ attributes: { style: `background:${color}33` } }).range(from, to));
          marks.push(Decoration.widget({ widget: new Caret(color, name), side: 1 }).range(head.index + offset));
        } catch { /* Ignore malformed peer awareness; it never changes note text. */ }
      }
      this.decorations = Decoration.set(marks, true);
    }
    destroy() {
      this.unsubscribe();
      this.sync?.provider.awareness.setLocalStateField('cursor', null);
      this.sync?.provider.awareness.off('change', this.schedule);
      if (this.frame !== null) (this.view.dom.ownerDocument.defaultView || window).cancelAnimationFrame(this.frame);
    }
  }, { decorations: (plugin) => plugin.decorations });
}
