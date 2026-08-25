with open("extension/src/__tests__/content-script.test.ts", "r") as f:
    content = f.read()

content = content.replace('      "",\n    );', '      "",\n      ["10", "50", "100", "500"],\n    );')
content = content.replace('      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",\n    );', '      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",\n      ["10", "50", "100", "500"],\n    );')

with open("extension/src/__tests__/content-script.test.ts", "w") as f:
    f.write(content)
