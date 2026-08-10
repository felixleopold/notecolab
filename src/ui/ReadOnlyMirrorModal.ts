import { Modal, type App, type TFile } from 'obsidian';

export class ReadOnlyMirrorModal extends Modal {
  constructor(
    app: App,
    private file: TFile,
    private createCopy: () => void,
    private deleteMirror: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'This shared note is read-only' });
    contentEl.createEl('p', {
      text: `"${this.file.basename}" receives updates from its owner. Editing the mirror directly would make it unclear which version is authoritative.`,
    });
    contentEl.createEl('p', {
      text: 'Create your own editable copy, or remove the mirror and stop receiving updates.',
    });

    const actions = contentEl.createDiv();
    actions.setCssStyles({
      display: 'flex',
      flexWrap: 'wrap',
      gap: '8px',
      justifyContent: 'flex-end',
    });

    const keep = actions.createEl('button', { text: 'Keep viewing' });
    keep.addEventListener('click', () => this.close());

    const remove = actions.createEl('button', { text: 'Delete & stop updates' });
    remove.addEventListener('click', () => {
      this.close();
      this.deleteMirror();
    });

    const copy = actions.createEl('button', {
      text: 'Create editable copy',
      cls: 'mod-cta',
    });
    copy.addEventListener('click', () => {
      this.close();
      this.createCopy();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
