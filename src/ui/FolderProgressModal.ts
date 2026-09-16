import { Modal, type App } from 'obsidian';

/** Small cancelable progress surface shared by folder publish and import integrations. */
export class FolderProgressModal extends Modal {
  private messageEl?: HTMLElement;
  private cancelled = false;

  constructor(app: App, private readonly title: string) {
    super(app);
  }

  get shouldContinue(): boolean {
    return !this.cancelled;
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: this.title });
    this.messageEl = this.contentEl.createEl('p', { text: 'Preparing…' });
    const cancel = this.contentEl.createEl('button', { text: 'Cancel after current file' });
    cancel.addEventListener('click', () => {
      this.cancelled = true;
      cancel.disabled = true;
      this.update('Stopping safely…');
    });
  }

  update(message: string) {
    this.messageEl?.setText(message);
  }

  finish(message: string) {
    this.cancelled = true;
    this.update(message);
    window.setTimeout(() => this.close(), 1_500);
  }

  onClose() {
    this.cancelled = true;
    this.contentEl.empty();
  }
}
