const { ModuleFederationPlugin } = require('webpack').container;
const deps = require('./package.json').dependencies;

module.exports = {
  mode: 'production',
  output: { publicPath: 'auto' },
  plugins: [
    new ModuleFederationPlugin({
      name: 'shell',
      remotes: { michsot: 'MichsotSheten@http://localhost:8890/remoteEntry.js' },
      shared: { react: { singleton: true, requiredVersion: deps.react } },
    }),
  ],
  devServer: { port: 3000, headers: { 'x-deps': Object.keys(deps).length } },
};
