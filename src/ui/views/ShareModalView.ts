import { Modal, type App } from 'obsidian';
import ShareNoteComponent from '../components/ShareNote.svelte';
import type { Contact } from '../../types';

export interface ShareOptions {
  accessMode: 'public_edit' | 'invited_edit' | 'read_only';
  expiresIn: number;
  showHelp: boolean;
  collaborators: string[];
  /** Reader presentation for read-only links (encoded into the share URL). */
  theme: 'auto' | 'light' | 'dark';
  showHeader: boolean;
  showControls: boolean;
  showChrome: boolean;
}

export class ShareModalView extends Modal {
  private component: InstanceType<typeof ShareNoteComponent> | null = null;
  private defaults: ShareOptions;
  private contacts: Contact[];
  private onSubmit: (result: ShareOptions) => void;

  constructor(app: App, defaults: ShareOptions, contacts: Contact[], onSubmit: (result: ShareOptions) => void) {
    super(app);
    this.defaults = defaults;
    this.contacts = contacts;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    contentEl.addClass('notecolab-share-modal');

    modalEl.setCssStyles({ width: '620px', maxWidth: '90vw' });

    this.component = new ShareNoteComponent({
      target: contentEl,
      props: {
        accessMode: this.defaults.accessMode,
        expiresIn: this.defaults.expiresIn,
        showHelp: this.defaults.showHelp,
        theme: this.defaults.theme,
        showHeader: this.defaults.showHeader,
        showControls: this.defaults.showControls,
        showChrome: this.defaults.showChrome,
        contacts: this.contacts,
        collaborators: [...(this.defaults.collaborators || [])],
        submitting: false,
      },
    });

    this.component.$on('share', (e: CustomEvent<ShareOptions>) => {
      this.component?.$set({ submitting: true });
      this.close();
      this.onSubmit(e.detail);
    });
  }

  onClose(): void {
    this.component?.$destroy();
    this.component = null;
  }
}
