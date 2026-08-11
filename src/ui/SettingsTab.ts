import { Modal, Notice, PluginSettingTab, Setting, type App, requestUrl } from 'obsidian';
import type ColabPlugin from '../main';
import { DEFAULT_SETTINGS, type Contact } from '../types';
import { destroyAllShareSyncs } from '../session/sessions';
import { ApiClient } from '../api/client';
import { deriveVaultKey, encryptWithVaultKey } from '../crypto/crypto';

/**
 * Only open http(s) checkout URLs. The URL is returned by the (user-configured,
 * possibly untrusted) server; a non-http scheme like obsidian:// or file:// must
 * never be handed to the OS protocol handler. (security audit #14)
 */
function isSafeCheckoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export class ColabSettingsTab extends PluginSettingTab {
  plugin: ColabPlugin;

  constructor(app: App, plugin: ColabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Connection').setHeading();

    const serverSetting = new Setting(containerEl)
      .setName('Server URL')
      .setDesc(this.plugin.settings.apiKey
        ? `Connected to ${this.plugin.settings.serverUrl}`
        : 'Not connected — enter a URL and click Connect');

    let pendingUrl = this.plugin.settings.serverUrl;
    serverSetting.addText((text) => {
      text
        .setPlaceholder('https://notecolab.com')
        .setValue(this.plugin.settings.serverUrl)
        .onChange((v) => { pendingUrl = v.trim().replace(/\/+$/, ''); });
    });
    serverSetting.addButton((btn) => {
      btn.setButtonText('Connect').setCta().onClick(async () => {
        if (!pendingUrl) {
          new Notice('Please enter a server URL');
          return;
        }
        btn.setDisabled(true);
        btn.setButtonText('Connecting…');

        // Validate the server
        try {
          const res = await requestUrl({ url: `${pendingUrl}/api/v1/ping` });
          if (res.status !== 200) throw new Error('Bad response');
        } catch {
          new Notice('Cannot reach server at ' + pendingUrl);
          btn.setButtonText('Connect');
          btn.setDisabled(false);
          return;
        }

        const urlChanged = pendingUrl !== this.plugin.settings.serverUrl;

        if (urlChanged || !this.plugin.settings.apiKey) {
          if (this.plugin.settings.apiKey) {
            const confirmed = await this.confirmAction(
              'Create an account on another server?',
              'A different server has a separate identity. Your existing notes, storage plan, and subscription will remain on the current server.',
              'Create account',
            );
            if (!confirmed) {
              btn.setButtonText('Connect');
              btn.setDisabled(false);
              return;
            }
          }

          const identity = await this.registerAtServer(pendingUrl);
          if (identity) {
            destroyAllShareSyncs(this.plugin.app);
            this.applyFreshIdentity(pendingUrl, identity);
            await this.plugin.saveSettings();
            this.plugin.api = new ApiClient(this.plugin.settings);
            new Notice('Connected to ' + pendingUrl);
          }
        } else {
          new Notice('Connection verified');
        }

        this.display(); // refresh to show updated status
      });
    });
    serverSetting.addButton((btn) => {
      btn.setButtonText('Restore account').onClick(async () => {
        if (!pendingUrl) {
          new Notice('Please enter the account server URL');
          return;
        }
        const credentials = await new Promise<{ uid: string; password: string } | null>((resolve) => {
          new RestoreAccountModal(this.app, pendingUrl, resolve).open();
        });
        if (!credentials) return;

        btn.setDisabled(true).setButtonText('Restoring…');
        try {
          const kp = await import('../crypto/keyExchange').then((module) => module.generateKeyPair());
          const recoveryClient = new ApiClient({
            ...this.plugin.settings,
            serverUrl: pendingUrl,
            apiKey: '',
            uid: '',
          });
          const result = await recoveryClient.recoverPlugin(credentials.uid, credentials.password, kp.publicKey);
          if ('error' in result) {
            new Notice(result.error);
            return;
          }

          let vaultKey = '';
          if (result.vaultSalt) {
            try {
              vaultKey = await deriveVaultKey(credentials.password, result.vaultSalt);
            } catch (error) {
              console.warn('Account restored but vault-key derivation failed:', error);
            }
          }
          destroyAllShareSyncs(this.plugin.app);
          this.plugin.settings.serverUrl = pendingUrl;
          this.plugin.settings.uid = result.uid;
          this.plugin.settings.apiKey = result.apiKey;
          this.plugin.settings.publicKey = kp.publicKey;
          this.plugin.settings.secretKey = kp.secretKey;
          this.plugin.settings.vaultKey = vaultKey;
          this.plugin.settings.username = result.displayName || '';
          this.plugin.settings.usernamePromptState = result.displayName ? 'done' : 'after_shares';
          await this.plugin.saveSettings();
          this.plugin.api = new ApiClient(this.plugin.settings);
          new Notice('Account restored. The previous plugin credential is now invalid. Pending invitations encrypted for the old device may need to be resent.', 12_000);
          this.display();
        } catch (error) {
          console.error('Account recovery failed:', error);
          new Notice('Could not restore the account. Your current local settings were kept.');
        } finally {
          btn.setDisabled(false).setButtonText('Restore account');
        }
      });
    });

    containerEl.createEl('p', {
      text: 'Used NoteColab before? Restore the existing account instead of connecting as a new user, or its notes and paid storage will remain attached to the old User ID.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Your authentication key (auto-generated on connect)')
      .addText((text) => {
        text
          .setValue(this.plugin.settings.apiKey ? '••••••••' : 'Not registered')
          .setDisabled(true);
      });

    const uidSetting = new Setting(containerEl)
      .setName('User ID')
      .setDesc('Your unique identifier — share this with collaborators so they can add you as an invited editor')
      .addText((text) => {
        text
          .setValue(this.plugin.settings.uid || 'Not registered')
          .setDisabled(true);
      });
    if (this.plugin.settings.uid) {
      uidSetting.addButton((btn) => {
        btn.setButtonText('Copy').onClick(() => {
          navigator.clipboard.writeText(this.plugin.settings.uid);
          new Notice('User ID copied to clipboard');
        });
      });
    }

    let pendingUsername = this.plugin.settings.username;
    new Setting(containerEl)
      .setName('Public username')
      .setDesc('Shown when someone adds your User ID and in the server admin dashboard. Contacts can replace it with a private alias.')
      .addText((text) => text
        .setPlaceholder('Optional username')
        .setValue(this.plugin.settings.username)
        .onChange((value) => { pendingUsername = value.trim(); }))
      .addButton((button) => button.setButtonText('Save').onClick(async () => {
        if (pendingUsername && (pendingUsername.length < 2 || pendingUsername.length > 40)) {
          new Notice('Username must be between 2 and 40 characters');
          return;
        }
        button.setDisabled(true).setButtonText('Saving…');
        const result = await this.plugin.api.setUsername(pendingUsername || null);
        if (result?.ok) {
          this.plugin.settings.username = result.username || '';
          this.plugin.settings.usernamePromptState = 'done';
          await this.plugin.saveSettings();
          new Notice(result.username ? 'Username saved' : 'Username removed');
        } else {
          new Notice('Could not save username');
        }
        button.setDisabled(false).setButtonText('Save');
      }));

    new Setting(containerEl)
      .setName('Default access mode')
      .setDesc('Default access level when sharing notes')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('read_only', 'View-only link')
          .addOption('public_edit', 'Editable link')
          .addOption('invited_edit', 'Invited collaborators')
          .setValue(this.plugin.settings.defaultAccessMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultAccessMode = value as any;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Default link expiry')
      .setDesc('Default expiration time for share links')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('0', 'Never expires')
          .addOption('3600', '1 hour')
          .addOption('86400', '24 hours')
          .addOption('604800', '7 days')
          .addOption('2592000', '30 days')
          .setValue(String(this.plugin.settings.defaultTtlSeconds))
          .onChange(async (value) => {
            this.plugin.settings.defaultTtlSeconds = parseInt(value, 10);
            await this.plugin.saveSettings();
          });
      });

    // Auto-accept setting
    new Setting(containerEl)
      .setName('Auto-accept shared notes')
      .setDesc('Automatically import notes shared with you, with no prompt. When off, a popup lets you accept or deny each incoming share.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoImport)
          .onChange(async (value) => {
            this.plugin.settings.autoImport = value;
            await this.plugin.saveSettings();
          });
      });

    // Plan & storage section (populated asynchronously)
    const planContainer = containerEl.createDiv();
    void this.renderPlanSection(planContainer);

    // Trusted contacts section
    new Setting(containerEl).setName('Trusted contacts').setHeading();
    containerEl.createEl('p', {
      text: 'Add contacts by User ID. Their public username is filled in automatically; an optional alias is private to this vault.',
      cls: 'setting-item-description',
    });

    const contactsContainer = containerEl.createDiv();
    this.renderContacts(contactsContainer);

    // Web Dashboard section
    new Setting(containerEl).setName('Web dashboard').setHeading();
    containerEl.createEl('p', {
      text: 'Set a password to access your shared notes from the web dashboard and restore this account after a reset or device replacement. Save your User ID too. This also encrypts your note keys for web access.',
      cls: 'setting-item-description',
    });

    let webPassword = '';
    let webConfirmPassword = '';

    const pwSetting = new Setting(containerEl)
      .setName('Web password')
      .setDesc(this.plugin.settings.vaultKey ? 'Password is set' : 'No password set');

    pwSetting.addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder('Password (min 8 chars)').onChange((v) => { webPassword = v; });
    });
    pwSetting.addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder('Confirm password').onChange((v) => { webConfirmPassword = v; });
    });
    pwSetting.addButton((btn) => {
      btn.setButtonText('Save').setCta().onClick(async () => {
        if (webPassword.length < 8) {
          new Notice('Password must be at least 8 characters');
          return;
        }
        if (webPassword !== webConfirmPassword) {
          new Notice('Passwords do not match');
          return;
        }
        btn.setDisabled(true);
        btn.setButtonText('Saving...');
        const result = await this.plugin.api.setPassword(webPassword);
        if (result.ok && result.vaultSalt) {
          try {
            const vaultKey = await deriveVaultKey(webPassword, result.vaultSalt);
            const noteKeys = this.collectNoteKeys();
            if (noteKeys.length > 0) {
              const encrypted: { noteShareId: string; encryptedKey: string }[] = [];
              for (const nk of noteKeys) {
                encrypted.push({ noteShareId: nk.noteShareId, encryptedKey: await encryptWithVaultKey(nk.encryptionKey, vaultKey) });
              }
              await this.plugin.api.uploadVaultKeys(encrypted);
            }
            this.plugin.settings.vaultKey = vaultKey;
            await this.plugin.saveSettings();
            new Notice('Web password set. ' + noteKeys.length + ' key(s) synced.');
          } catch (e) {
            console.warn('Failed to sync vault keys:', e);
            new Notice('Password set, but failed to sync keys. Try syncing manually.');
          }
        } else if (result.ok) {
          new Notice('Web password set');
        } else {
          new Notice('Failed to set password');
        }
        btn.setButtonText('Save');
        btn.setDisabled(false);
        this.display();
      });
    });

    if (this.plugin.settings.vaultKey) {
      new Setting(containerEl)
        .setName('Sync vault keys')
        .setDesc('Re-encrypt and upload all note keys for web dashboard access')
        .addButton((btn) => {
          btn.setButtonText('Sync now').onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText('Syncing...');
            const noteKeys = this.collectNoteKeys();
            if (noteKeys.length === 0) {
              new Notice('No shared notes to sync');
              btn.setButtonText('Sync now');
              btn.setDisabled(false);
              return;
            }
            const encrypted: { noteShareId: string; encryptedKey: string }[] = [];
            for (const nk of noteKeys) {
              encrypted.push({ noteShareId: nk.noteShareId, encryptedKey: await encryptWithVaultKey(nk.encryptionKey, this.plugin.settings.vaultKey) });
            }
            const ok = await this.plugin.api.uploadVaultKeys(encrypted);
            if (ok) {
              new Notice('Synced ' + encrypted.length + ' vault key(s)');
            } else {
              new Notice('Failed to sync vault keys');
            }
            btn.setButtonText('Sync now');
            btn.setDisabled(false);
          });
        });
    }

    // Identity lifecycle
    new Setting(containerEl).setName('Danger zone').setHeading();

    new Setting(containerEl)
      .setName('Rotate API key')
      .setDesc('Replaces this plugin identity key. Existing web sessions and shared notes are kept.')
      .addButton((btn) => {
        btn
          .setButtonText('Rotate')
          .setWarning()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText('Rotating...');
            const result = await this.plugin.api.rotateApiKey();
            if (result?.apiKey) {
              this.plugin.settings.apiKey = result.apiKey;
              await this.plugin.saveSettings();
              this.plugin.api = new ApiClient(this.plugin.settings);
              new Notice('API key rotated. The new key has been saved.');
            } else {
              new Notice('Failed to rotate API key');
            }
            btn.setButtonText('Rotate');
            btn.setDisabled(false);
          });
      });

    new Setting(containerEl)
      .setName('Create a new account')
      .setDesc('Starts over with a new User ID. The current account, notes, and paid storage stay on the old User ID.')
      .addButton((btn) => {
        btn
          .setButtonText('Create new')
          .setWarning()
          .onClick(async () => {
            const confirmed = await this.confirmAction(
              'Create a new NoteColab account?',
              'This does not move your notes or storage subscription. Without a saved User ID and recovery password, the old account may be permanently inaccessible.',
              'Create new account',
            );
            if (!confirmed) return;

            btn.setDisabled(true).setButtonText('Creating…');
            const identity = await this.registerAtServer(this.plugin.settings.serverUrl);
            if (identity) {
              destroyAllShareSyncs(this.plugin.app);
              this.applyFreshIdentity(this.plugin.settings.serverUrl, identity);
              await this.plugin.saveSettings();
              this.plugin.api = new ApiClient(this.plugin.settings);
              new Notice('New account created. The previous account was not deleted or transferred.');
              this.display();
            }
            btn.setDisabled(false).setButtonText('Create new');
          });
      });
  }

  private async registerAtServer(serverUrl: string): Promise<{
    uid: string;
    apiKey: string;
    publicKey: string;
    secretKey: string;
  } | null> {
    const registrationClient = new ApiClient({
      ...this.plugin.settings,
      serverUrl,
      apiKey: '',
      uid: '',
    });
    const info = await registrationClient.getServerInfo();
    const mode = info?.registration?.mode || 'open';
    if (mode === 'closed') {
      new Notice('This server is private and closed to self-registration. Ask the admin to provision an account.');
      return null;
    }

    let inviteCode: string | undefined;
    if (mode === 'invite') {
      const code = await new Promise<string | null>((resolve) => {
        new InviteCodeModal(this.app, serverUrl, resolve).open();
      });
      if (!code) {
        new Notice('An invite code is required to register on this server.');
        return null;
      }
      inviteCode = code;
    }

    try {
      const kp = await import('../crypto/keyExchange').then((module) => module.generateKeyPair());
      const registered = await registrationClient.register(kp.publicKey, inviteCode);
      return { ...registered, publicKey: kp.publicKey, secretKey: kp.secretKey };
    } catch (error) {
      console.error('Registration failed:', error);
      const status = (error as { status?: number }).status;
      new Notice(status === 403
        ? 'Registration was rejected — the invite code may be wrong, or this server is closed.'
        : 'Server reachable but registration failed. Your current account was kept.');
      return null;
    }
  }

  private applyFreshIdentity(serverUrl: string, identity: {
    uid: string;
    apiKey: string;
    publicKey: string;
    secretKey: string;
  }): void {
    this.plugin.settings.serverUrl = serverUrl;
    this.plugin.settings.uid = identity.uid;
    this.plugin.settings.apiKey = identity.apiKey;
    this.plugin.settings.publicKey = identity.publicKey;
    this.plugin.settings.secretKey = identity.secretKey;
    this.plugin.settings.contacts = [];
    this.plugin.settings.vaultKey = DEFAULT_SETTINGS.vaultKey;
    this.plugin.settings.username = DEFAULT_SETTINGS.username;
    this.plugin.settings.usernamePromptState = DEFAULT_SETTINGS.usernamePromptState;
    this.plugin.settings.sharedNoteCount = DEFAULT_SETTINGS.sharedNoteCount;
  }

  private confirmAction(title: string, message: string, confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmActionModal(this.app, title, message, confirmLabel, resolve).open();
    });
  }

  /** Show the current plan, storage usage, and an upgrade path (if offered). */
  private async renderPlanSection(container: HTMLElement) {
    container.empty();
    if (!this.plugin.settings.apiKey) return;

    new Setting(container).setName('Plan & storage').setHeading();
    const loading = container.createEl('p', { text: 'Loading plan…', cls: 'setting-item-description' });

    const info = await this.plugin.api.getBillingInfo();
    loading.remove();
    if (!info || !info.storage) {
      container.createEl('p', { text: 'Could not load plan info.', cls: 'setting-item-description' });
      return;
    }

    const storage = info.storage;
    const plan = info.plan || 'free';
    const currentPlan = info.plans[plan];
    const upgradePlans = Object.values(info.plans)
      .filter((candidate) => candidate.checkoutAvailable && candidate.id !== plan
        && (candidate.quotaBytes <= 0 || (!storage.unlimited && candidate.quotaBytes > storage.limitBytes)))
      .sort((a, b) => (a.quotaBytes <= 0 ? Number.POSITIVE_INFINITY : a.quotaBytes)
        - (b.quotaBytes <= 0 ? Number.POSITIVE_INFINITY : b.quotaBytes));
    const planName = currentPlan?.name || plan;

    if (upgradePlans.length > 0 && !info.recoveryConfigured) {
      container.createEl('p', {
        text: '⚠ Strongly recommended before paying: set a Web password below and save your User ID. Without both, a plugin reset or lost device can permanently strand this account, its notes, and its paid storage.',
        cls: 'setting-item-description',
      });
    }

    let usageText = storage.unlimited
      ? `${fmtBytes(storage.usedBytes)} used — unlimited`
      : `${fmtBytes(storage.usedBytes)} of ${fmtBytes(storage.limitBytes)} (${storage.usagePercent}%)`;
    if (currentPlan && !currentPlan.isDefault && info.planExpiresAt) {
      usageText += ` · ${planName} until ${new Date(info.planExpiresAt).toLocaleDateString()}`;
    }

    const planSetting = new Setting(container)
      .setName(`Current plan: ${planName}`)
      .setDesc(usageText);

    planSetting.addExtraButton((btn) => {
      btn.setIcon('refresh-cw').setTooltip('Refresh plan').onClick(() => this.renderPlanSection(container));
    });

    for (const upgradePlan of upgradePlans) {
      const quota = upgradePlan.quotaBytes <= 0 ? 'Unlimited storage*' : `${fmtBytes(upgradePlan.quotaBytes)} storage`;
      const description = [upgradePlan.description, quota, upgradePlan.priceLabel].filter(Boolean).join(' · ');
      new Setting(container)
        .setName(upgradePlan.name)
        .setDesc(description)
        .addButton((btn) => {
          const label = `Choose ${upgradePlan.name}`;
          btn.setButtonText(label).setCta().onClick(async () => {
            if (!info.recoveryConfigured) {
              const proceed = await this.confirmAction(
                'No account recovery password is set',
                `You can still buy ${upgradePlan.name}, but a plugin reset or lost device may permanently strand the subscription and stored notes. Strongly consider cancelling now, setting a Web password below, and saving your User ID.`,
                'Continue anyway',
              );
              if (!proceed) {
                new Notice('Checkout cancelled. Set a Web password and save your User ID before trying again.');
                return;
              }
            }
            btn.setDisabled(true);
            btn.setButtonText('Opening…');
            const res = await this.plugin.api.createCheckout(upgradePlan.id);
            if (res && 'url' in res && res.url && isSafeCheckoutUrl(res.url)) {
              window.open(res.url, '_blank');
              new Notice('Complete your upgrade in the browser, then click Refresh.');
            } else if (res && 'url' in res && res.url) {
              // Server returned a non-http(s) URL — never hand it to a protocol handler.
              new Notice('Server returned an invalid checkout URL.');
            } else {
              new Notice(res && 'error' in res ? res.error : 'Could not start checkout');
            }
            btn.setDisabled(false);
            btn.setButtonText(label);
          });
        });
    }

    // Usage bar
    if (!storage.unlimited) {
      const bar = container.createDiv();
      bar.setCssStyles({
        height: '6px',
        borderRadius: '3px',
        background: 'var(--background-modifier-border)',
        margin: '4px 0 12px',
      });
      const pct = Math.min(100, storage.usagePercent);
      const fill = bar.createDiv();
      fill.setCssStyles({
        height: '100%',
        width: `${pct}%`,
        borderRadius: '3px',
        background: pct >= 95
          ? 'var(--text-error)'
          : pct >= 80
            ? 'var(--color-orange, orange)'
            : 'var(--interactive-accent)',
      });
    }

    // Footnote: availability or self-hosting hint.
    if (!info.checkoutAvailable) {
      container.createEl('p', {
        text: storage.unlimited
          ? 'This server provides unlimited storage.'
          : 'Paid upgrades are unavailable on this server. You can free up space or run your own server — see the project README.',
        cls: 'setting-item-description',
      });
    } else if (upgradePlans.length > 0) {
      container.createEl('p', {
        text: 'Prefer self-hosting? You can run your own server — see the project README.',
        cls: 'setting-item-description',
      });
    }
    if ((currentPlan?.quotaBytes ?? 1) <= 0 || upgradePlans.some((candidate) => candidate.quotaBytes <= 0)) {
      container.createEl('p', {
        text: '* Unlimited storage is available as long as the Note Colab server has sufficient storage capacity.',
        cls: 'setting-item-description',
      });
    }
  }

  private renderContacts(container: HTMLElement) {
    container.empty();
    const contacts = this.plugin.settings.contacts;

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      new Setting(container)
        .setName(c.name)
        .setDesc(c.uid.substring(0, 16) + '...')
        .addButton((btn) => {
          btn.setButtonText('Copy UID').onClick(() => {
            navigator.clipboard.writeText(c.uid);
            new Notice('UID copied');
          });
        })
        .addButton((btn) => {
          btn.setButtonText('Remove').setWarning().onClick(async () => {
            contacts.splice(i, 1);
            await this.plugin.saveSettings();
            this.renderContacts(container);
          });
        });
    }

    // Add contact form
    let newAlias = '';
    let newUid = '';
    new Setting(container)
      .setName('Add contact')
      .addText((text) => {
        text.setPlaceholder('Alias (optional)').onChange((v) => { newAlias = v.trim(); });
      })
      .addText((text) => {
        text.setPlaceholder('User UID').onChange((v) => { newUid = v.trim(); });
      })
      .addButton((btn) => {
        btn.setButtonText('Add').setCta().onClick(async () => {
          if (!newUid) {
            new Notice('Please enter a User ID');
            return;
          }
          if (newUid === this.plugin.settings.uid) {
            new Notice("That's your own UID");
            return;
          }
          if (contacts.some((c) => c.uid === newUid)) {
            new Notice('Contact already exists');
            return;
          }
          // Verify the user exists by checking their public key
          const info = await this.plugin.api.getPublicKey(newUid);
          if (!info) {
            new Notice('User not found. Make sure they have the plugin installed.');
            return;
          }
          const displayName = newAlias || info.displayName || `User ${newUid.substring(0, 8)}`;
          contacts.push({ uid: newUid, name: displayName });
          await this.plugin.saveSettings();
          new Notice(info.displayName && !newAlias
            ? `Added ${info.displayName}`
            : `Added ${displayName}${info.displayName ? ` (${info.displayName})` : ''}`);
          this.renderContacts(container);
        });
      });
  }

  /** Collect all shared notes' encryption keys from vault frontmatter */
  private collectNoteKeys(): { noteShareId: string; encryptionKey: string }[] {
    const results: { noteShareId: string; encryptionKey: string }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm?.colab_share_id) continue;
      const key = fm.colab_encryption_key ||
        (fm.colab_link ? fm.colab_link.split('#')[1] : '');
      if (key) {
        results.push({ noteShareId: fm.colab_share_id, encryptionKey: key });
      }
    }
    return results;
  }

}

class RestoreAccountModal extends Modal {
  private resolved = false;
  private uid = '';
  private password = '';

  constructor(
    app: App,
    private serverUrl: string,
    private resolve: (credentials: { uid: string; password: string } | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Restore an existing account' });
    contentEl.createEl('p', {
      text: `Sign in to the account on ${this.serverUrl}. This transfers it to this plugin installation and invalidates the previous plugin credential. Your User ID, notes, storage usage, and paid plan stay together.`,
    });
    contentEl.createEl('p', {
      text: 'A new encryption keypair will be created. Pending invitations encrypted for a lost device may need to be resent.',
      cls: 'setting-item-description',
    });

    const submit = () => {
      const uid = this.uid.trim();
      if (!uid || !this.password) {
        new Notice('Enter your User ID and recovery password');
        return;
      }
      this.resolved = true;
      this.resolve({ uid, password: this.password });
      this.close();
    };

    new Setting(contentEl)
      .setName('User ID')
      .addText((text) => text.setPlaceholder('Your existing User ID').onChange((value) => { this.uid = value; }));
    new Setting(contentEl)
      .setName('Password')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Web / recovery password').onChange((value) => { this.password = value; });
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); submit(); }
        });
      });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText('Restore account').onClick(submit));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }
}

class ConfirmActionModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmLabel: string,
    private resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: this.message });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button.setWarning().setButtonText(this.confirmLabel).onClick(() => {
        this.resolved = true;
        this.resolve(true);
        this.close();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(false);
    }
  }
}

/** Prompt for the invite code an `invite`-mode server requires to register. */
class InviteCodeModal extends Modal {
  private resolved = false;
  private code = '';

  constructor(
    app: App,
    private serverUrl: string,
    private resolve: (code: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Invite code required' });
    contentEl.createEl('p', {
      text: `${this.serverUrl} is a private server and only accepts registrations with a valid invite code. ` +
        'Ask the server admin for one.',
    });

    const submit = () => {
      const code = this.code.trim();
      if (!code) {
        new Notice('Please enter an invite code');
        return;
      }
      this.resolved = true;
      this.resolve(code);
      this.close();
    };

    new Setting(contentEl)
      .setName('Invite code')
      .addText((text) => {
        text.setPlaceholder('Invite code').onChange((v) => { this.code = v; });
        text.inputEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        });
      });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setCta().setButtonText('Register').onClick(submit));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }
}
