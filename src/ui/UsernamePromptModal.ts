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
    contentEl.createEl('h2', { text: 'Add a Note Colab username?' });
    contentEl.createEl('p', {
      text: this.reason === 'upgrade'
        ? 'Note Colab can now attach a public username to your User ID.'
        : 'You have shared three notes. If you want, you can now make your User ID easier for collaborators to recognize.',
    });
    contentEl.createEl('p', {
      text: 'When someone adds your User ID as a contact, this username appears automatically. They can still choose a private alias that only they see. Your username is also visible to the Note Colab administrator.',
    });

    new Setting(contentEl)
      .setName('Username')
      .setDesc('2–40 characters. It does not need to be unique; your User ID remains your identity.')
      .addText((text) => text
        .setPlaceholder('Your name')
        .onChange((value) => { this.username = value.trim(); }));

    const actions = new Setting(contentEl);
    actions.addButton((button) => button
      .setButtonText('Not now')
      .onClick(() => this.close()));
    actions.addButton((button) => button
      .setButtonText('Add username')
      .setCta()
      .onClick(async () => {
        if (this.username.length < 2 || this.username.length > 40) {
          new Notice('Username must be between 2 and 40 characters');
          return;
        }
        button.setDisabled(true).setButtonText('Saving…');
        if (!await this.saveUsername(this.username)) {
          new Notice('Could not save username');
          button.setDisabled(false).setButtonText('Add username');
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
