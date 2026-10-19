import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 本切片不做 standalone 打包（属部署阶段）；仅保证本机 dev / build 可用。
  reactStrictMode: true,
  typedRoutes: false,

  // 开发环境必须显式放行 127.0.0.1。
  //
  // 为什么：README 与 .env.example 都让主人打开 http://127.0.0.1:3100，
  // 但 Next dev 默认把 127.0.0.1 视为**跨源**并拦掉 /_next/* 等开发资源
  // （dev server 日志：`Blocked cross-origin request to Next.js dev resource ... from "127.0.0.1"`）。
  // 后果不是"样式有点怪"，而是**客户端组件完全不 hydrate** ——
  // 导航栏永远停在"正在读取登录状态…"、按钮点了没反应，
  // 任何人都会因此判断"前端坏了"，而实际代码没问题。
  //
  // 这只影响开发服务器；生产构建不受影响。
  // 本机用局域网地址（192.168.22.250）看 dev 时，也要显式放行，否则 /_next/* 被拦。
  allowedDevOrigins: ['127.0.0.1', 'localhost', '192.168.22.250', '10.42.0.1'],

  // 请求访问日志：生产下默认**不**打，出问题时"哪个接口 500 了、哪个页面慢"就无从看起。
  // 这里打开 Next 自带的 incoming request 日志（一行一条：方法 路径 状态码 耗时），
  // 但把静态资源与健康检查排掉 —— 它们量最大、信息量最小，会把日志淹掉。
  logging: {
    incomingRequests: {
      ignore: [/^\/_next\//, /^\/api\/health/, /^\/favicon\.ico$/],
    },
  },
};

export default nextConfig;
