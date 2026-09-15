// retired 2026-09-15: temporary Playtomic API probe. Delete this function in the Supabase dashboard.
Deno.serve(() => new Response(JSON.stringify({ error: "gone" }), { status: 410, headers: { "Content-Type": "application/json" } }));
