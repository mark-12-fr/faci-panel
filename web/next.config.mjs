/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The legacy app used plain <img> tags and remote avatar hosts (ui-avatars).
  // Keep images unoptimized so no next/image host allow-list is needed and the
  // markup stays identical to the original.
  images: { unoptimized: true },
};

export default nextConfig;
