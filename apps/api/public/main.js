"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var jsx_runtime_1 = require("react/jsx-runtime");
var client_1 = require("react-dom/client");
var App_js_1 = require("./App.js");
(0, client_1.createRoot)(document.getElementById("root")).render((0, jsx_runtime_1.jsx)(App_js_1.default, {}));
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () { });
}
