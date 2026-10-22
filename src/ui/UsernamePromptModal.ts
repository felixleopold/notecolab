import { Modal, Notice, Setting, type App } from 'obsidian';

export class UsernamePromptModal extends Modal {
  private resolved = false;
  private username = '';

  constructor(
    app: App,
    private readonly reason: 'upgrade' | 'after_shares',
    private readonly saveUsername: (username: string) => Promise<boolean>,
    private readonly finish: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Add a public display name?' });
    contentEl.createEl('p', {
      text: this.reason === 'upgrade'
        ? 'Note Colab can now show a name alongside your User ID.'
        : 'A display name can help frequent collaborators recognize you.',
    });
    contentEl.createEl('p', {
      text: 'This is optional and does not need to be unique. It is visible to the server, to people who add your User ID as a contact, and to authorized participants while you are present in a shared note. Private contact aliases stay in each collaborator’s vault.',
    });

    new Setting(contentEl)
      .setName('Public display name')
      .setDesc('2–40 characters. Your User ID remains your identity.')
      .addText((text) => text
        .setPlaceholder('How collaborators should see you')
        .onChange((value) => { this.username = value.trim(); }));

    const actions = new Setting(contentEl);
    actions.addButton((button) => button
      .setButtonText('Not now')
      .onClick(() => this.close()));
    actions.addButton((button) => button
      .setButtonText('Save display name')
      .setCta()
      .onClick(async () => {
        if (this.username.length < 2 || this.username.length > 40) {
          new Notice('Display name must be between 2 and 40 characters');
          return;
        }
        button.setDisabled(true).setButtonText('Saving…');
        if (!await this.saveUsername(this.username)) {
          new Notice('Could not save display name');
          button.setDisabled(false).setButtonText('Save display name');
          return;
        }
        this.close();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolved) return;
    this.resolved = true;
    void this.finish();
  }
}
