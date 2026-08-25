import json

for file in ["extension/manifest.json", "extension/manifest.firefox.json"]:
    with open(file, "r") as f:
        m = json.load(f)
    
    m["commands"] = {
        "preset-1": {
            "suggested_key": {
                "default": "Ctrl+1",
                "mac": "MacCtrl+1"
            },
            "description": "Select Preset 1"
        },
        "preset-2": {
            "suggested_key": {
                "default": "Ctrl+2",
                "mac": "MacCtrl+2"
            },
            "description": "Select Preset 2"
        },
        "preset-3": {
            "suggested_key": {
                "default": "Ctrl+3",
                "mac": "MacCtrl+3"
            },
            "description": "Select Preset 3"
        },
        "preset-4": {
            "suggested_key": {
                "default": "Ctrl+4",
                "mac": "MacCtrl+4"
            },
            "description": "Select Preset 4"
        }
    }

    with open(file, "w") as f:
        json.dump(m, f, indent=2)

