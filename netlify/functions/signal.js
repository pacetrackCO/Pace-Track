let peers = {};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const body = JSON.parse(event.body || "{}");
    const { id, target, data } = body;

    if (!id || !target || !data) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing parameters" }) };
    }

    if (!peers[target]) peers[target] = [];
    peers[target].push({ from: id, data });

    if (peers[target].length > 50) {
      peers[target] = peers[target].slice(-20);
    }

    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: JSON.stringify({ ok: true })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};