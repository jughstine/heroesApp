const express = require("express");
const router = express.Router();

router.get("/psa/orders/:reference_number", async (req, res) => {
  const { reference_number } = req.params;

  if (!reference_number) {
    return res.status(400).json({
      success: false,
      message: "Reference number is required",
    });
  }

  try {
    const response = await fetch(
      `${process.env.PSA_API_BASE_URL}/orders/${reference_number}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PSA_API_TOKEN}`,
        },
      },
    );

    switch (response.status) {
      case 401:
        return res
          .status(401)
          .json({ success: false, message: "PSA token is invalid" });
      case 403:
        return res
          .status(403)
          .json({ success: false, message: "PSA token lacks permission" });
      case 404:
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      case 429:
        return res
          .status(429)
          .json({ success: false, message: "Too many requests to PSA API" });
      case 503:
        return res
          .status(503)
          .json({ success: false, message: "PSA API is under maintenance" });
    }

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: `PSA API returned an error: ${response.status}`,
      });
    }

    const json = await response.json();

    return res.json({
      success: true,
      data: {
        state: json.data.state,
      },
    });
  } catch (err) {
    console.error("PSA order fetch error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error while contacting PSA API",
    });
  }
});

module.exports = router;
