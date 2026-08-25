import re

with open("extension/src/__tests__/content-script.test.ts", "r") as f:
    content = f.read()

# buildBodyContent(address, project, false, "") => buildBodyContent(address, project, false, "", ["10", "50", "100", "500"])
content = content.replace(
    'buildBodyContent(\n      "GABC",\n      null,\n      false,\n      "",\n    );',
    'buildBodyContent(\n      "GABC",\n      null,\n      false,\n      "",\n      ["10", "50", "100", "500"],\n    );'
)
content = content.replace(
    'buildBodyContent(\n      "GABC",\n      testProject,\n      true,\n      "GBPK",\n    );',
    'buildBodyContent(\n      "GABC",\n      testProject,\n      true,\n      "GBPK",\n      ["10", "50", "100", "500"],\n    );'
)
content = content.replace(
    'buildBodyContent(\n      "GXYZ",\n      { ...testProject, verified: false },\n      false,\n      "",\n    );',
    'buildBodyContent(\n      "GXYZ",\n      { ...testProject, verified: false },\n      false,\n      "",\n      ["10", "50", "100", "500"],\n    );'
)

with open("extension/src/__tests__/content-script.test.ts", "w") as f:
    f.write(content)
