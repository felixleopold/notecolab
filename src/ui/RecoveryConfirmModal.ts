import { Modal, type App } from 'obsidian';

export class RecoveryConfirmModal extends Modal {
  constructor(app: App, private readonly onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Recover previous version?' });
    this.contentEl.createEl('p', {
      text: 'NoteColab will decrypt the newest retained revision into a separate local Markdown file. The shared note and its current contents will not be changed.',
    });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const recover = row.createEl('button', { text: 'Recover to new file' });
    recover.setCssStyles({ background: 'var(--interactive-accent)', color: 'var(--text-on-accent)' });
    recover.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
