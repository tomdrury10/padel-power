// retired 2026-09-15: one-off staff account setup. Delete this function in the Supabase dashboard.
Deno.serve(() => new Response(JSON.stringify({ error: "gone" }), { status: 410, headers: { "Content-Type": "application/json" } }));
