import { Modal, Setting, type App } from 'obsidian';

export class DeleteConfirmModal extends Modal {
  private noteTitle: string;
  private onChoice: (deleteFromServer: boolean) => void;

  constructor(app: App, noteTitle: string, onChoice: (deleteFromServer: boolean) => void) {
    super(app);
    this.noteTitle = noteTitle;
    this.onChoice = onChoice;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Shared Note Deleted' });

    const desc = contentEl.createDiv();
    desc.style.marginBottom = '16px';
    desc.style.lineHeight = '1.5';

    desc.createEl('p', {
      text: `"${this.noteTitle}" was shared via Note Colab and still exists on the server.`,
    });

    desc.createEl('p', {
      text: 'Would you like to also delete it from the server database?',
    });

    // Explanation box
    const infoBox = contentEl.createDiv();
    infoBox.style.padding = '12px';
    infoBox.style.marginBottom = '16px';
    infoBox.style.borderRadius = '8px';
    infoBox.style.border = '1px solid var(--background-modifier-border)';
    infoBox.style.fontSize = '13px';
    infoBox.style.lineHeight = '1.5';

    infoBox.createEl('strong', { text: 'What happens if you delete from server:' });
    const deleteList = infoBox.createEl('ul');
    deleteList.style.margin = '4px 0 8px 0';
    deleteList.createEl('li', { text: 'All share links will stop working immediately' });
    deleteList.createEl('li', { text: 'Embedded images are permanently removed' });
    deleteList.createEl('li', { text: 'Anyone with the link will no longer be able to view or edit' });
    deleteList.createEl('li', { text: 'This frees up storage on the server' });

    infoBox.createEl('strong', { text: 'What happens if you keep on server:' });
    const keepList = infoBox.createEl('ul');
    keepList.style.margin = '4px 0 0 0';
    keepList.createEl('li', { text: 'Share links remain active — anyone with the link can still access the note' });
    keepList.createEl('li', { text: 'You can re-import the note later using the share link' });
    keepList.createEl('li', { text: 'The note continues to use server storage' });
    keepList.createEl('li', { text: 'Notes unused for 1 year are automatically cleaned up' });

    // Buttons
    const btnRow = contentEl.createDiv();
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.justifyContent = 'flex-end';

    const keepBtn = btnRow.createEl('button', { text: 'Keep on server' });
    keepBtn.addEventListener('click', () => {
      this.onChoice(false);
      this.close();
    });

    const deleteBtn = btnRow.createEl('button', { text: 'Delete from server (recommended)' });
    deleteBtn.style.background = 'var(--interactive-accent)';
    deleteBtn.style.color = 'var(--text-on-accent)';
    deleteBtn.addEventListener('click', () => {
      this.onChoice(true);
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
