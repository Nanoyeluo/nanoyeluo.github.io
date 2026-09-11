'use strict';

// 在页面底部注入 mermaid.js（ESM 方式加载 mermaid 11），
// 配合 hexo-filter-mermaid-diagrams 插件渲染正文中的 ```mermaid 代码块。
hexo.extend.injector.register('body_end', `
<script type="module">
  import mermaid from 'https://unpkg.com/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
</script>
`, 'default');
