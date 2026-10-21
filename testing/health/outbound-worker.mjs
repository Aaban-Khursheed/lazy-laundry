export default {
  async fetch() {
    const response = await fetch("https://must-not-resolve.invalid/").catch(() => null);
    return Response.json({ blocked: !response || !response.ok });
  },
};
