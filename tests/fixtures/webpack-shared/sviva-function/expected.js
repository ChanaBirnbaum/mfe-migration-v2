const HtmlWebPackPlugin = require("html-webpack-plugin");
const ModuleFederationPlugin = require("webpack/lib/container/ModuleFederationPlugin");
const path = require('path');

const pkg = require("./package.json");
const { buildSharedGen1 } = require("@ips/mfe-shared-deps");

module.exports = ({ sviva }) => {
  const PORT = 8890;
  const envVriables = {
    local: { output: { publicPath: `http://localhost:${PORT}/` } },
    dev: { output: { publicPath: 'https://dev.example/michsot/' } },
    test: { output: { publicPath: 'https://test.example/michsot/' } },
    prod: { output: { path: path.resolve(__dirname, 'dist') } },
  };

  const config = {
    output: envVriables[sviva].output,
    plugins: [
      new ModuleFederationPlugin({
        name: "MichsotSheten",
        filename: "remoteEntry.js",
        exposes: { './MichsotSheten': "./src/App.jsx" },
        // MIGRATION-V2: previous shared config
        // shared: {
        //   ...deps,
        //   react: { singleton: true, requiredVersion: deps.react },
        //   "react-dom": { singleton: true, requiredVersion: deps["react-dom"] },
        // },
        shared: buildSharedGen1({ pkg, require, role: 'remote' }),
      }),
      new HtmlWebPackPlugin({ template: "./src/index.html" }),
    ],
  };
  return config;
};
