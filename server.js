const express = require("express");
const app = express();

app.use(express.static(__dirname));

app.listen(8081, "0.0.0.0", () => {
  console.log("StackPilot Dashboard running on port 8081");
});
