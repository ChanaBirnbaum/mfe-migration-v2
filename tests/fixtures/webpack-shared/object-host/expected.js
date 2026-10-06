const { ModuleFederationPlugin } = require('webpack').container;
const deps = require('./package.json').dependencies;
const pkg = require('./package.json');
const { buildSharedGen1 } = require('@ips/mfe-shared-deps');

module.exports = {
  mode: 'production',
  output: { publicPath: 'auto' },
  plugins: [
    new ModuleFederationPlugin({
      name: 'shell',
      remotes: { michsot: 'MichsotSheten@http://localhost:8890/remoteEntry.js' },
      // MIGRATION-V2: previous shared config
      // shared: { react: { singleton: true, requiredVersion: deps.react } },
      shared: buildSharedGen1({ pkg, require, role: 'host' }),
    }),
  ],
  devServer: { port: 3000, headers: { 'x-deps': Object.keys(deps).length } },
};
