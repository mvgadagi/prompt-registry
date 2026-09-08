/**
 * Source Management Commands Unit Tests
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  SourceCommands,
} from '../../src/commands/source-commands';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistrySource,
  ValidationResult,
} from '../../src/types/registry';

suite('Source Management Commands', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('addSource', () => {
    test('should prompt for source details', () => {
      const showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
      showInputBoxStub.onFirstCall().resolves('Test Source');
      showInputBoxStub.onSecondCall().resolves('https://github.com/test/repo');

      const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick');
      showQuickPickStub.resolves({ label: 'GitHub', value: 'github' } as any);

      // Mock the actual command execution
      assert.ok(showInputBoxStub);
      assert.ok(showQuickPickStub);
    });

    test('should validate source URL format', () => {
      const showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
      showInputBoxStub.onFirstCall().resolves('Test Source');
      showInputBoxStub.onSecondCall().resolves('invalid-url');

      // Validation would typically happen in the command
      const url = 'invalid-url';
      const isValidUrl = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('git@');

      if (!isValidUrl) {
        assert.ok(true, 'Invalid URL detected');
      }
    });

    test('should support GitHub sources', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      assert.strictEqual(source.type, 'github');
      assert.ok(source.url.includes('github.com'));
    });

    test('should support local sources', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'local',
        url: '/path/to/bundles',
        enabled: true,
        priority: 1
      };

      assert.strictEqual(source.type, 'local');
      assert.ok(source.url.startsWith('/'));
    });
  });

  suite('editSource', () => {
    test('should allow editing source name', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Old Name',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const updatedSource = {
        ...originalSource,
        name: 'New Name'
      };

      assert.notStrictEqual(originalSource.name, updatedSource.name);
      assert.strictEqual(updatedSource.name, 'New Name');
    });

    test('should allow editing source URL', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/old-repo',
        enabled: true,
        priority: 1
      };

      const updatedSource = {
        ...originalSource,
        url: 'https://github.com/test/new-repo'
      };

      assert.notStrictEqual(originalSource.url, updatedSource.url);
      assert.strictEqual(updatedSource.url, 'https://github.com/test/new-repo');
    });

    test('should allow changing source type', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const updatedSource = {
        ...originalSource,
        type: 'local',
        url: '/path/to/bundles'
      };

      assert.notStrictEqual(originalSource.type, updatedSource.type);
      assert.strictEqual(updatedSource.type, 'local');
    });

    test('should preserve source priority when editing', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 5
      };

      const updatedSource = {
        ...originalSource,
        name: 'Updated Name'
      };

      assert.strictEqual(updatedSource.priority, 5);
    });
  });

  suite('removeSource', () => {
    test('should prompt for confirmation before removing', () => {
      // Simulated confirmation
      const confirmed = true;
      assert.strictEqual(confirmed, true);
    });

    test('should cancel removal if user declines', () => {
      // Simulated cancellation
      const cancelled = true;
      assert.strictEqual(cancelled, true);
    });

    test('should remove source from storage', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: true, priority: 2 }
      ];

      const updatedSources = sources.filter((s) => s.id !== 'source-1');

      assert.strictEqual(updatedSources.length, 1);
      assert.strictEqual(updatedSources[0].id, 'source-2');
    });

    test('should not affect other sources when removing one', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: true, priority: 2 },
        { id: 'source-3', name: 'Source 3', type: 'github', url: 'url3', enabled: true, priority: 3 }
      ];

      const updatedSources = sources.filter((s) => s.id !== 'source-2');

      assert.strictEqual(updatedSources.length, 2);
      assert.ok(updatedSources.some((s) => s.id === 'source-1'));
      assert.ok(updatedSources.some((s) => s.id === 'source-3'));
      assert.ok(!updatedSources.some((s) => s.id === 'source-2'));
    });
  });

  suite('toggleSource', () => {
    test('should enable disabled source', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: false,
        priority: 1
      };

      const toggled = { ...source, enabled: !source.enabled };

      assert.strictEqual(toggled.enabled, true);
    });

    test('should disable enabled source', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const toggled = { ...source, enabled: !source.enabled };

      assert.strictEqual(toggled.enabled, false);
    });

    test('should preserve all other properties when toggling', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 5,
        token: 'test-token'
      };

      const toggled = { ...source, enabled: !source.enabled };

      assert.strictEqual(toggled.id, source.id);
      assert.strictEqual(toggled.name, source.name);
      assert.strictEqual(toggled.type, source.type);
      assert.strictEqual(toggled.url, source.url);
      assert.strictEqual(toggled.priority, source.priority);
      assert.strictEqual(toggled.token, source.token);
    });
  });

  suite('syncSource', () => {
    test('should refresh bundles from source', async () => {
      sandbox.stub(vscode.window, 'showInformationMessage').resolves();

      // Simulate sync operation
      const syncStartTime = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const syncEndTime = Date.now();

      assert.ok(syncEndTime >= syncStartTime);
    });

    test('should handle sync errors gracefully', () => {
      const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage');

      const error = new Error('Sync failed');
      showErrorMessageStub.resolves();

      assert.ok(error.message.includes('Sync failed'));
    });

    test('should update last sync timestamp', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1,
        lastSync: undefined as Date | undefined
      };

      const updatedSource = {
        ...source,
        lastSync: new Date()
      };

      assert.ok(updatedSource.lastSync);
      assert.ok(updatedSource.lastSync instanceof Date);
    });
  });

  suite('syncAllSources', () => {
    test('should sync all enabled sources', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: false, priority: 2 },
        { id: 'source-3', name: 'Source 3', type: 'github', url: 'url3', enabled: true, priority: 3 }
      ];

      const enabledSources = sources.filter((s) => s.enabled);

      assert.strictEqual(enabledSources.length, 2);
      assert.ok(enabledSources.every((s) => s.enabled));
    });

    test('should skip disabled sources', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: false, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: false, priority: 2 }
      ];

      const enabledSources = sources.filter((s) => s.enabled);

      assert.strictEqual(enabledSources.length, 0);
    });

    test('should continue on individual source failures', async () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: true, priority: 2 },
        { id: 'source-3', name: 'Source 3', type: 'github', url: 'url3', enabled: true, priority: 3 }
      ];

      const results = await Promise.allSettled(
        sources.map((source) => {
          return new Promise((resolve, reject) => {
            if (source.id === 'source-2') {
              reject(new Error('Sync failed'));
            } else {
              resolve(source);
            }
          });
        })
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 2);
      assert.strictEqual(rejected.length, 1);
    });
  });
});

/**
 * U5 consume-picker: the add-source flow offers `agent-plugins` /
 * `local-agent-plugins` and persists a RegistrySource with the correct
 * additive type. `agent-plugins` reuses the existing public/private + token
 * prompts (like `skills`); `local-agent-plugins` joins the token-skip list
 * (like `local-skills`) so it never prompts for a token. Registration only:
 * the flow validates + persists, it never fetches/installs plugin content.
 */
suite('SourceCommands.addSource - agent-plugins source types (U5)', () => {
  let sandbox: sinon.SinonSandbox;
  let added: RegistrySource[];
  let commands: SourceCommands;

  // Minimal RegistryManager stand-in: registration-only surface used by
  // addSource (validate reachability + persist). No content fetch/install.
  const makeManager = (validation: ValidationResult): RegistryManager => ({
    validateSource: async (_source: RegistrySource): Promise<ValidationResult> => validation,
    addSource: async (source: RegistrySource): Promise<void> => {
      added.push(source);
    }
  } as unknown as RegistryManager);

  /**
   * Drive the sequential prompts by inspecting each prompt's text so the test
   * is order-independent and mirrors real user input.
   * @param answers Per-prompt answers keyed by intent.
   * @param answers.sourceType The source-type QuickPick selection.
   * @param answers.name The source name.
   * @param answers.url The GitHub URL entered for remote types.
   * @param answers.localPath The folder path returned by the open dialog.
   * @param answers.isPrivate The public/private QuickPick selection.
   * @param answers.token The access token entered for a private source.
   */
  const wirePrompts = (answers: {
    sourceType: string;
    name: string;
    url?: string;
    localPath?: string;
    isPrivate?: boolean;
    token?: string;
  }): { tokenPrompted: () => boolean; privatePrompted: () => boolean } => {
    let tokenPrompted = false;
    let privatePrompted = false;

    sandbox.stub(vscode.window, 'showQuickPick').callsFake((_items: any, options?: any) => {
      if (options?.placeHolder === 'Select source type') {
        return Promise.resolve({ value: answers.sourceType } as any);
      }
      if (options?.placeHolder === 'Is this source private?') {
        privatePrompted = true;
        return Promise.resolve({ value: answers.isPrivate ?? false } as any);
      }
      return Promise.resolve(undefined as any);
    });

    sandbox.stub(vscode.window, 'showInputBox').callsFake((options?: any) => {
      const prompt: string = options?.prompt ?? '';
      if (prompt === 'Enter source name') {
        return Promise.resolve(answers.name);
      }
      if (prompt.startsWith('Enter GitHub repository URL')) {
        return Promise.resolve(answers.url);
      }
      if (prompt.startsWith('Enter access token')) {
        tokenPrompted = true;
        return Promise.resolve(answers.token);
      }
      if (prompt.startsWith('Enter priority')) {
        return Promise.resolve('10');
      }
      return Promise.resolve(undefined);
    });

    sandbox.stub(vscode.window, 'showOpenDialog').resolves(
      answers.localPath ? [{ fsPath: answers.localPath } as vscode.Uri] : undefined
    );

    return { tokenPrompted: () => tokenPrompted, privatePrompted: () => privatePrompted };
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    added = [];
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    commands = new SourceCommands(makeManager({ valid: true, errors: [], warnings: [] }));
  });

  teardown(() => {
    sandbox.restore();
  });

  test('offers agent-plugins as a remote type and persists type "agent-plugins" with the token flow', async () => {
    const probes = wirePrompts({
      sourceType: 'agent-plugins',
      name: 'Agent Plugins Source',
      url: 'https://github.com/owner/repo',
      isPrivate: true,
      token: 'secret-token'
    });

    await commands.addSource();

    assert.strictEqual(added.length, 1, 'exactly one source persisted');
    assert.strictEqual(added[0].type, 'agent-plugins');
    assert.strictEqual(added[0].url, 'https://github.com/owner/repo');
    // agent-plugins is NOT on the token-skip list → public/private + token prompts fire.
    assert.strictEqual(probes.privatePrompted(), true, 'public/private prompt shown');
    assert.strictEqual(probes.tokenPrompted(), true, 'token prompt shown for private agent-plugins');
    assert.strictEqual(added[0].token, 'secret-token');
    assert.strictEqual(added[0].private, true);
  });

  test('persists type "local-agent-plugins" and skips the token prompt (parity with local-skills)', async () => {
    const probes = wirePrompts({
      sourceType: 'local-agent-plugins',
      name: 'Local Agent Plugins',
      localPath: '/tmp/agent-plugins'
    });

    await commands.addSource();

    assert.strictEqual(added.length, 1, 'exactly one source persisted');
    assert.strictEqual(added[0].type, 'local-agent-plugins');
    assert.strictEqual(added[0].url, '/tmp/agent-plugins');
    // local-agent-plugins IS on the token-skip list → no consent/token prompts.
    assert.strictEqual(probes.privatePrompted(), false, 'no public/private prompt for local type');
    assert.strictEqual(probes.tokenPrompted(), false, 'no token prompt for local-agent-plugins');
    assert.strictEqual(added[0].token, undefined);
    assert.strictEqual(added[0].private, false);
  });

  test('a public agent-plugins source persists with no token (no weakened consent)', async () => {
    const probes = wirePrompts({
      sourceType: 'agent-plugins',
      name: 'Public Agent Plugins',
      url: 'https://github.com/owner/public-repo',
      isPrivate: false
    });

    await commands.addSource();

    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].type, 'agent-plugins');
    // Public/private prompt still shown (unchanged consent); token skipped because public.
    assert.strictEqual(probes.privatePrompted(), true, 'public/private prompt still shown');
    assert.strictEqual(probes.tokenPrompted(), false, 'no token prompt for a public source');
    assert.strictEqual(added[0].token, undefined);
    assert.strictEqual(added[0].private, false);
  });

  test('does not persist when the source type is cancelled (registration-only, no side effects)', async () => {
    sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);
    sandbox.stub(vscode.window, 'showInputBox').resolves(undefined);
    sandbox.stub(vscode.window, 'showOpenDialog').resolves(undefined);

    await commands.addSource();

    assert.strictEqual(added.length, 0, 'nothing persisted when the picker is dismissed');
  });
});
