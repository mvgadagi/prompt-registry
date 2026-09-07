/**
 * Tests for the U6 "Agent Plugin" affordance in MarketplaceViewProvider.
 *
 * Covers C1 (marketplace):
 *  - loadBundles carries the resolved source type onto the posted bundle data
 *    so the card webview can render the static "Agent Plugin" badge.
 *  - getBundleDetailsHtml (Screen 2) injects the "Agent Plugin" badge span iff
 *    the bundle's source type is 'agent-plugins', through the same injected-span
 *    template pattern as the "Installed" badge (no new raw interpolation).
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  SetupState,
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  Bundle,
  InstalledBundle,
  RegistrySource,
} from '../../src/types/registry';
import {
  MarketplaceViewProvider,
} from '../../src/ui/marketplace-view-provider';

const PROJECT_ROOT = process.cwd();

const makeBundle = (overrides: Partial<Bundle> = {}): Bundle => ({
  id: 'bundle-1',
  name: 'Test Bundle',
  version: '1.0.0',
  description: 'A bundle for U6 badge tests',
  author: 'Test Author',
  sourceId: 'src-1',
  environments: ['vscode'],
  tags: [],
  lastUpdated: '2024-01-01',
  size: '1MB',
  dependencies: [],
  license: 'MIT',
  manifestUrl: 'https://example.com/manifest.yml',
  downloadUrl: 'https://example.com/bundle.zip',
  ...overrides
});

const makeSource = (type: RegistrySource['type']): RegistrySource => ({
  id: 'src-1',
  name: 'Test Source',
  type,
  url: 'https://example.com/registry',
  enabled: true,
  priority: 1
});

suite('MarketplaceViewProvider - Agent Plugin badge (U6 C1)', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let mockSetupStateManager: sinon.SinonStubbedInstance<SetupStateManager>;
  let provider: MarketplaceViewProvider;
  let postedMessages: any[];
  let mockWebview: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    postedMessages = [];

    mockContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file(PROJECT_ROOT),
      extensionPath: PROJECT_ROOT,
      extensionMode: 2
    } as any;

    mockWebview = {
      postMessage: (message: any) => {
        postedMessages.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: sandbox.stub().returns({ dispose: () => {} }),
      asWebviewUri: (uri: vscode.Uri) => uri,
      cspSource: "'self'",
      options: {},
      html: ''
    };

    mockRegistryManager = {
      onBundleInstalled: sandbox.stub().returns({ dispose: () => {} }),
      onBundleUninstalled: sandbox.stub().returns({ dispose: () => {} }),
      onBundleUpdated: sandbox.stub().returns({ dispose: () => {} }),
      onBundlesInstalled: sandbox.stub().returns({ dispose: () => {} }),
      onBundlesUninstalled: sandbox.stub().returns({ dispose: () => {} }),
      onSourceSynced: sandbox.stub().returns({ dispose: () => {} }),
      onAutoUpdatePreferenceChanged: sandbox.stub().returns({ dispose: () => {} }),
      onRepositoryBundlesChanged: sandbox.stub().returns({ dispose: () => {} }),
      onReadmeDownloaded: sandbox.stub().returns({ dispose: () => {} }),
      searchBundles: sandbox.stub().resolves([]),
      listInstalledBundles: sandbox.stub().resolves([]),
      listSources: sandbox.stub().resolves([]),
      autoUpdateService: null
    } as any;

    mockSetupStateManager = {
      getState: sandbox.stub().resolves(SetupState.COMPLETE)
    } as any;

    provider = new MarketplaceViewProvider(
      mockContext,
      mockRegistryManager,
      mockSetupStateManager
    );

    (provider as any)._view = { webview: mockWebview };
    (provider as any).webviewReady = true;
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('loadBundles carries source type to the card webview', () => {
    test('posts sourceType "agent-plugins" for a bundle from an agent-plugins source', async () => {
      mockRegistryManager.searchBundles.resolves([makeBundle()]);
      mockRegistryManager.listSources.resolves([makeSource('agent-plugins')]);

      await (provider as any).loadBundles();

      const message = postedMessages.find((m) => m.type === 'bundlesLoaded');
      assert.ok(message, 'bundlesLoaded message should be posted');
      assert.strictEqual(message.bundles.length, 1);
      assert.strictEqual(message.bundles[0].sourceType, 'agent-plugins');
    });

    test('posts the real source type (github) for a non-agent-plugins source', async () => {
      mockRegistryManager.searchBundles.resolves([makeBundle()]);
      mockRegistryManager.listSources.resolves([makeSource('github')]);

      await (provider as any).loadBundles();

      const message = postedMessages.find((m) => m.type === 'bundlesLoaded');
      assert.ok(message, 'bundlesLoaded message should be posted');
      assert.strictEqual(message.bundles[0].sourceType, 'github');
    });
  });

  suite('getBundleDetailsHtml badge gating (Screen 2)', () => {
    let tempRoot: string;
    let detailWebview: any;
    const breakdown = {
      prompts: 0,
      instructions: 0,
      chatmodes: 0,
      agents: 0,
      skills: 0,
      mcpServers: 0
    };

    setup(() => {
      // Write the real detail template into a temp dist tree so the provider's
      // fs.readFileSync(dist/webview/bundle-details/bundle-details.html) resolves
      // without depending on a prior webpack build.
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'u6-detail-'));
      const destDir = path.join(tempRoot, 'dist', 'webview', 'bundle-details');
      fs.mkdirSync(destDir, { recursive: true });
      const srcTemplate = path.join(
        PROJECT_ROOT, 'src', 'ui', 'webview', 'bundle-details', 'bundle-details.html'
      );
      fs.copyFileSync(srcTemplate, path.join(destDir, 'bundle-details.html'));

      (provider as any).context = {
        ...mockContext,
        extensionUri: vscode.Uri.file(tempRoot)
      };

      detailWebview = {
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: "'self'"
      };
    });

    teardown(() => {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const renderDetail = (sourceType?: string, installed?: InstalledBundle): string =>
      (provider as any).getBundleDetailsHtml(
        detailWebview,
        makeBundle(),
        installed,
        breakdown,
        false,
        sourceType
      );

    test('injects the "Agent Plugin" badge for an agent-plugins bundle', () => {
      const html = renderDetail('agent-plugins');

      assert.match(html, /<span class="badge agent-plugin-badge">.*Agent Plugin<\/span>/);
      // Placeholder must be substituted, never left raw.
      assert.doesNotMatch(html, /\{\{agentPluginBadge\}\}/);
    });

    test('omits the badge for a non-agent-plugins bundle (github)', () => {
      const html = renderDetail('github');

      assert.ok(!html.includes('agent-plugin-badge'), 'badge must be absent for github source');
      assert.doesNotMatch(html, /\{\{agentPluginBadge\}\}/);
    });

    test('omits the badge when no source type is resolved', () => {
      const html = renderDetail(undefined);

      assert.ok(!html.includes('agent-plugin-badge'), 'badge must be absent when sourceType is undefined');
      assert.doesNotMatch(html, /\{\{agentPluginBadge\}\}/);
    });
  });
});
