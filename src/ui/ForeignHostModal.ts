import { Modal, type App } from 'obsidian';

export type ForeignHostDecision = 'once' | 'always' | 'cancel';

/**
 * Confirmation shown before the plugin talks to a host embedded in a pasted
 * share link that differs from the user's configured server. Importing or
 * collaborating cross-server means issuing requests to an arbitrary origin the
 * link carries, so gate it behind an explicit trust prompt. (issue #8)
 */
export class ForeignHostModal extends Modal {
  private linkOrigin: string;
  private configuredOrigin: string;
  private onChoice: (decision: ForeignHostDecision) => void;
  private resolved = false;

  constructor(
    app: App,
    linkOrigin: string,
    configuredOrigin: string,
    onChoice: (decision: ForeignHostDecision) => void
  ) {
    super(app);
    this.linkOrigin = linkOrigin;
    this.configuredOrigin = configuredOrigin;
    this.onChoice = onChoice;
  }

  private choose(decision: ForeignHostDecision) {
    if (this.resolved) return;
    this.resolved = true;
    this.onChoice(decision);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Import from a different server?' });

    const desc = contentEl.createDiv();
    desc.style.marginBottom = '16px';
    desc.style.lineHeight = '1.5';

    const p = desc.createEl('p');
    p.appendText('This link points at ');
    p.createEl('strong', { text: this.linkOrigin });
    p.appendText(', not your configured server ');
    p.createEl('strong', { text: this.configuredOrigin });
    p.appendText('.');

    desc.createEl('p', {
      text: `Continuing will send requests to ${this.linkOrigin} to fetch and collaborate on this note. Only proceed if you trust that server.`,
    });

    const btnRow = contentEl.createDiv();
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.flexWrap = 'wrap';

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.choose('cancel'));

    const alwaysBtn = btnRow.createEl('button', { text: `Always trust ${this.linkOrigin}` });
    alwaysBtn.addEventListener('click', () => this.choose('always'));

    const onceBtn = btnRow.createEl('button', { text: 'Import once' });
    onceBtn.style.background = 'var(--interactive-accent)';
    onceBtn.style.color = 'var(--text-on-accent)';
    onceBtn.addEventListener('click', () => this.choose('once'));
  }

  onClose() {
    this.contentEl.empty();
    // Treat a dismissed modal (Esc / click-away) as a cancel so the caller
    // never hangs waiting on a decision.
    if (!this.resolved) {
      this.resolved = true;
      this.onChoice('cancel');
    }
  }
}
