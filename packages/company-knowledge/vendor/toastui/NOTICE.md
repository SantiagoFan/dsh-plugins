# 第三方组件：Toast UI Editor

本目录下的 `toastui-editor.js` / `toastui-editor.css` 是 [@toast-ui/editor](https://github.com/nhn/tui.editor) v3.2.3 的浏览器构建产物，
由本插件在构建时用 Rollup 打包成 IIFE（全局 `window.toastui.Editor`），不依赖 CDN，内网离线可用。

- 许可证：MIT
- 版权：Copyright (c) NHN Cloud FE Development Lab
- 源包版本：`@toast-ui/editor@3.2.3`

## 重新构建

```bash
mkdir vendor-build && cd vendor-build
npm init -y
npm i @toast-ui/editor@3.2.3 rollup @rollup/plugin-node-resolve @rollup/plugin-commonjs @rollup/plugin-terser
```

`src/entry.js`：

```js
import Editor from '@toast-ui/editor'
import '@toast-ui/editor/dist/i18n/zh-cn'

window.toastui = window.toastui || {}
window.toastui.Editor = Editor
```

`rollup.config.mjs`：

```js
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'

export default {
  input: 'src/entry.js',
  output: { file: 'out/toastui-editor.js', format: 'iife', name: 'ToastUIEditorBundle' },
  plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs(), terser()],
}
```

```bash
npx rollup -c rollup.config.mjs
cp node_modules/@toast-ui/editor/dist/toastui-editor.css ../toastui-editor.css
cp out/toastui-editor.js ../toastui-editor.js
```

## MIT License

Copyright (c) NHN Cloud FE Development Lab

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
