const fs = require("fs");
const path = require("path");

const root = __dirname;
const entry = "main.js";
const modules = ["shared.js", "runtime.js", "view.js", "main.js"];

function readModule(fileName) {
  const fullPath = path.join(root, fileName);
  return fs.readFileSync(fullPath, "utf8");
}

function escapeKey(fileName) {
  return `./${fileName.replace(/\\/g, "/").replace(/\.js$/i, "")}`;
}

const serializedModules = modules
  .map((fileName) => {
    const source = readModule(fileName);
    return `${JSON.stringify(escapeKey(fileName))}: function(module, exports, require) {\n${source}\n}`;
  })
  .join(",\n");

const bundle = `(function(){\nconst __nativeRequire = typeof require === "function" ? require : null;\nconst __modules = {\n${serializedModules}\n};\nconst __cache = {};\nfunction __require(id){\n  if(__cache[id]) return __cache[id].exports;\n  if(__modules[id]) {\n    const module = { exports: {} };\n    __cache[id] = module;\n    __modules[id](module, module.exports, __require);\n    return module.exports;\n  }\n  if(__nativeRequire) {\n    return __nativeRequire(id);\n  }\n  throw new Error('Module not found: ' + id);\n}\nmodule.exports = __require(${JSON.stringify(escapeKey(entry))});\n})();\n`;

fs.writeFileSync(path.join(root, "main.bundle.js"), bundle, "utf8");
console.log("Built main.bundle.js");
