import { Modal, Setting, type App } from 'obsidian';

/** Confirm permanently deleting a shared note from the server. */
export class DeleteSharedNoteModal extends Modal {
  private readonly noteTitle: string;
  private readonly onConfirm: () => void;

  constructor(app: App, noteTitle: string, onConfirm: () => void) {
    super(app);
    this.noteTitle = noteTitle;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Delete shared note from server?' });
    const intro = contentEl.createEl('p');
    intro.createEl('strong', { text: `"${this.noteTitle}"` });
    intro.appendText(' will be permanently deleted from the Note Colab server.');
    const consequences = contentEl.createEl('ul');
    consequences.createEl('li', { text: 'Every share and invite link stops working, including links you already sent.' });
    consequences.createEl('li', { text: 'Collaborators lose access and pending deliveries are removed.' });
    consequences.createEl('li', { text: 'Uploaded images and the server copy are deleted.' });
    contentEl.createEl('p', {
      text: 'Any copy in your vault stays; only its sharing properties are removed. This cannot be undone.',
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('Delete from server').setWarning().onClick(() => {
        this.close();
        this.onConfirm();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
