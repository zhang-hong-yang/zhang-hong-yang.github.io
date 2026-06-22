---
icon: fas fa-info-circle
order: 4
---

{% assign author_name = site.social.name | default: site.title %}
{% assign visible_posts = site.posts | where_exp: 'post', 'post.hidden != true' %}
{% assign github_url = '' %}
{% if site.github.username %}
  {% assign github_url = 'https://github.com/' | append: site.github.username %}
{% elsif site.social.links.first %}
  {% assign github_url = site.social.links.first %}
{% endif %}

<section class="about-profile">
  <p class="about-kicker">ABOUT THIS INDEX</p>
  <h2>{{ author_name }} 的技术资料库</h2>
  <p>
    这里不是按时间线更新的动态站点，而是一个长期维护的技术笔记和常用工具手册。
    内容会围绕实际使用中遇到的问题、配置过程、工具选择和可复用的操作流程整理。
  </p>
</section>

<section class="about-metrics" aria-label="站点概览">
  <div>
    <strong>{{ visible_posts | size }}</strong>
    <span>篇笔记</span>
  </div>
  <div>
    <strong>{{ site.categories | size }}</strong>
    <span>个分类</span>
  </div>
  <div>
    <strong>{{ site.tags | size }}</strong>
    <span>个标签</span>
  </div>
</section>

<section class="about-section">
  <h2>记录范围</h2>
  <ul class="about-list">
    <li>开发环境、系统配置、命令行工具和常用软件的使用记录</li>
    <li>GitHub Pages、Jekyll、自动化部署等站点维护流程</li>
    <li>技术学习过程中值得复用的步骤、命令、排错思路和参考资料</li>
  </ul>
</section>

<section class="about-section">
  <h2>整理原则</h2>
  <ul class="about-list">
    <li>优先写清楚背景、适用场景和最终可执行步骤</li>
    <li>命令、配置和报错信息尽量保留上下文，方便以后复查</li>
    <li>文章会持续修订，旧内容不追求像动态博客一样按时间展示</li>
  </ul>
</section>

<section class="about-section about-contact">
  <h2>联系与源码</h2>
  <p>
    如果你发现内容有误，或有更好的实践方式，欢迎通过
    {% if github_url != '' %}
      <a href="{{ github_url }}" target="_blank" rel="noopener noreferrer">GitHub</a>
    {% else %}
      GitHub
    {% endif %}
    交流。
  </p>
</section>
