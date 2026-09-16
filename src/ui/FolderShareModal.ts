import { Modal, Setting, type App } from 'obsidian';
import type { FolderAccessMode } from '../share/folderShare';

export interface FolderShareChoice {
  folderPath: string;
  accessMode: FolderAccessMode;
}

export class FolderShareModal extends Modal {
  private folderPath = '';
  private accessMode: FolderAccessMode = 'read_only';

  constructor(app: App, private readonly onSubmit: (choice: FolderShareChoice) => void) {
    super(app);
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Share a folder' });
    this.contentEl.createEl('p', {
      text: 'NoteColab will recursively publish Markdown files and their supported images. While watching is on, new Markdown files are automatically published. Nothing is deleted remotely when a local file is removed.',
    });
    new Setting(this.contentEl)
      .setName('Vault folder')
      .setDesc('Enter its vault-relative path. You can run this again to publish additions, edits, and renames.')
      .addText((text) => text.setPlaceholder('Projects/Launch').onChange((value) => { this.folderPath = value.trim(); }));
    new Setting(this.contentEl)
      .setName('Recipient access')
      .addDropdown((dropdown) => dropdown
        .addOption('read_only', 'Read only')
        .addOption('public_edit', 'Anyone with the folder link can edit')
        .onChange((value) => { this.accessMode = value as FolderAccessMode; }));
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText('Review and publish')
      .setCta()
      .onClick(() => {
        if (!this.folderPath) return;
        this.close();
        this.onSubmit({ folderPath: this.folderPath, accessMode: this.accessMode });
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class FolderPublishPreviewModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly choice: FolderShareChoice,
    private readonly paths: string[],
    private readonly onDecision: (accepted: boolean) => void,
  ) {
    super(app);
  }

  private decide(accepted: boolean) {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(accepted);
    this.close();
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Publish this folder?' });
    this.contentEl.createEl('p', {
      text: `${this.paths.length} Markdown file${this.paths.length === 1 ? '' : 's'} from ${this.choice.folderPath} will be encrypted and shared. Embedded supported images are included.`,
    });
    const list = this.contentEl.createEl('ul');
    for (const path of this.paths.slice(0, 12)) list.createEl('li', { text: path });
    if (this.paths.length > 12) list.createEl('li', { text: `…and ${this.paths.length - 12} more` });
    this.contentEl.createEl('p', {
      text: 'While Obsidian is open, new Markdown files added to this folder will also be published. Edits and renames update automatically; editable notes must connect through normal note sync. Publishing again resumes failures. Local deletions only remove entries from the folder index; NoteColab does not delete their remote shares.',
    });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.decide(false));
    const publish = row.createEl('button', { text: 'Publish folder' });
    publish.setCssStyles({ background: 'var(--interactive-accent)', color: 'var(--text-on-accent)' });
    publish.addEventListener('click', () => this.decide(true));
  }

  onClose() {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.onDecision(false);
    }
  }
}
