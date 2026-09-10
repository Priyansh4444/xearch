import { query } from "./_generated/server";

/** Reactive arrival order, not tweet timestamp and not an external X firehose. */
export const recent = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("tweets").order("desc").take(20);
    return rows.map((row) => ({ ...row, author: null }));
  },
});
