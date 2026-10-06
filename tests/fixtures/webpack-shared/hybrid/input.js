const ModuleFederationPlugin = require("webpack/lib/container/ModuleFederationPlugin");
const deps = require("./package.json").dependencies;

module.exports = ({ sviva }) => ({
  plugins: [
    new ModuleFederationPlugin({
      name: "Hybrid",
      filename: "remoteEntry.js",
      exposes: { './Widget': "./src/Widget.jsx" },
      remotes: { shell: "shell@http://localhost:3000/remoteEntry.js" },
      shared: { ...deps },
    }),
  ],
});
