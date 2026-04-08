module.exports = {
  branches: ['main'],
  plugins: [
    ['@semantic-release/commit-analyzer', {
      preset: 'conventionalcommits',
      releaseRules: [
        { breaking: true, release: 'minor' },
        { type: 'feat', release: 'patch' },
        { type: 'fix', release: 'patch' },
        { type: 'perf', release: 'patch' },
        { type: 'refactor', release: 'patch' },
        { type: 'docs', release: false },
        { type: 'chore', release: false },
        { type: 'test', release: false },
        { type: 'ci', release: false },
        { type: 'style', release: false },
        { type: 'build', release: false },
      ],
    }],
    ['@semantic-release/release-notes-generator', {
      preset: 'conventionalcommits',
      presetConfig: {
        types: [
          { type: 'feat', section: 'Features' },
          { type: 'fix', section: 'Bug Fixes' },
          { type: 'perf', section: 'Performance' },
          { type: 'refactor', section: 'Refactoring' },
        ],
      },
    }],
    '@semantic-release/changelog',
    '@semantic-release/npm',
    ['@semantic-release/git', {
      assets: ['package.json', 'CHANGELOG.md'],
      message: 'release: ${nextRelease.gitTag} [skip ci]',
    }],
    '@semantic-release/github',
  ],
};
