import { Modal, Setting, type App } from 'obsidian';

/** Explain that a note's Original link was retired and no replacement exists yet. */
export class RetiredLinkModal extends Modal {
  private readonly onManageLinks: () => void;

  constructor(app: App, onManageLinks: () => void) {
    super(app);
    this.onManageLinks = onManageLinks;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Create a new link' });
    contentEl.createEl('p', { text: 'This note’s original link was retired for security. Create a new link.' });
    contentEl.createEl('p', {
      text: 'You and invited collaborators keep access. Anyone who only has the original link needs the new one.',
      cls: 'setting-item-description',
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Open manage links').setCta().onClick(() => {
        this.close();
        this.onManageLinks();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
