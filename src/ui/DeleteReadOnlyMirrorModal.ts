import { Modal, type App, type TFile } from 'obsidian';

export class DeleteReadOnlyMirrorModal extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private confirmDelete: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Delete read-only mirror?' });
    contentEl.createEl('p', {
      text: `"${this.file.basename}" will be moved to Obsidian trash and will stop receiving updates. The owner's note is not affected.`,
    });

    const actions = contentEl.createDiv();
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());

    const remove = actions.createEl('button', {
      text: 'Delete & stop updates',
      cls: 'mod-warning',
    });
    remove.addEventListener('click', () => {
      this.close();
      this.confirmDelete();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
