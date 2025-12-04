let peers = {};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const { id } = event.queryStringParameters || {};

    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing id parameter" }) };
    }

    const messages = peers[id] || [];
    peers[id] = [];

    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(messages)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};