// SPDX-FileCopyrightText: 2021 iteratec GmbH
//
// SPDX-License-Identifier: Apache-2.0

const { getCascadingScans } = require("./hook");

let parentScan = undefined;
let sslyzeCascadingRules = undefined;

beforeEach(() => {
  parentScan = {
    apiVersion: "execution.securecodebox.io/v1",
    kind: "Scan",
    metadata: {
      name: "nmap-foobar.com",
      annotations: {}
    },
    spec: {
      scanType: "nmap",
      parameters: "foobar.com",
      cascades: {}
    }
  };

  sslyzeCascadingRules = [
    {
      apiVersion: "cascading.securecodebox.io/v1",
      kind: "CascadingRule",
      metadata: {
        name: "tls-scans"
      },
      spec: {
        matches: {
          anyOf: [
            {
              category: "Open Port",
              attributes: {
                port: 443,
                service: "https"
              }
            },
            {
              category: "Open Port",
              attributes: {
                service: "https"
              }
            }
          ]
        },
        scanSpec: {
          scanType: "sslyze",
          parameters: ["--regular", "{{$.hostOrIP}}:{{attributes.port}}"]
        }
      }
    }
  ];
});

test("Should create subsequent scans for open HTTPS ports (NMAP findings)", () => {
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  expect(cascadedScans).toMatchInlineSnapshot(`
    Array [
      Object {
        "apiVersion": "execution.securecodebox.io/v1",
        "kind": "Scan",
        "metadata": Object {
          "annotations": Object {
            "cascading.securecodebox.io/chain": "tls-scans",
            "cascading.securecodebox.io/matched-finding": undefined,
            "cascading.securecodebox.io/parent-scan": "nmap-foobar.com",
            "securecodebox.io/hook": "cascading-scans",
          },
          "generateName": "sslyze-foobar.com-tls-scans-",
          "labels": Object {},
          "ownerReferences": Array [
            Object {
              "apiVersion": "execution.securecodebox.io/v1",
              "blockOwnerDeletion": true,
              "controller": true,
              "kind": "Scan",
              "name": "nmap-foobar.com",
              "uid": undefined,
            },
          ],
        },
        "spec": Object {
          "cascades": Object {},
          "env": Array [],
          "parameters": Array [
            "--regular",
            "foobar.com:443",
          ],
          "scanType": "sslyze",
          "volumeMounts": Array [],
          "volumes": Array [],
        },
      },
    ]
  `);
});

test("Should create no subsequent scans if there are no rules", () => {
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadingRules = [];

  const cascadedScans = getCascadingScans(parentScan, findings, cascadingRules);

  expect(cascadedScans).toMatchInlineSnapshot(`Array []`);
});

test("Should not try to do magic to the scan name if its something random", () => {
  parentScan.metadata.name = "foobar.com";

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: undefined,
        ip_address: "10.42.42.42",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  expect(cascadedScans[0].metadata.generateName).toEqual("foobar.com-tls-scans-");
});

test("Should not start a new scan when the corresponding cascadingRule is already in the chain", () => {
  parentScan.metadata.annotations["cascading.securecodebox.io/chain"] =
    sslyzeCascadingRules[0].metadata.name;

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  expect(cascadedScans).toMatchInlineSnapshot(`Array []`);
});

test("Should not crash when the annotations are not set", () => {
  parentScan.metadata.annotations = undefined;

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  expect(cascadedScans).toMatchInlineSnapshot(`
    Array [
      Object {
        "apiVersion": "execution.securecodebox.io/v1",
        "kind": "Scan",
        "metadata": Object {
          "annotations": Object {
            "cascading.securecodebox.io/chain": "tls-scans",
            "cascading.securecodebox.io/matched-finding": undefined,
            "cascading.securecodebox.io/parent-scan": "nmap-foobar.com",
            "securecodebox.io/hook": "cascading-scans",
          },
          "generateName": "sslyze-foobar.com-tls-scans-",
          "labels": Object {},
          "ownerReferences": Array [
            Object {
              "apiVersion": "execution.securecodebox.io/v1",
              "blockOwnerDeletion": true,
              "controller": true,
              "kind": "Scan",
              "name": "nmap-foobar.com",
              "uid": undefined,
            },
          ],
        },
        "spec": Object {
          "cascades": Object {},
          "env": Array [],
          "parameters": Array [
            "--regular",
            "foobar.com:443",
          ],
          "scanType": "sslyze",
          "volumeMounts": Array [],
          "volumes": Array [],
        },
      },
    ]
  `);
});

test("Should copy ENV fields from cascadingRule to created scan", () => {
  sslyzeCascadingRules[0].spec.scanSpec.env = [
    {
      name: "FOOBAR",
      valueFrom: { secretKeyRef: { name: "foobar-token", key: "token" } }
    }
  ];

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  expect(cascadedScans[0].spec.env).toMatchInlineSnapshot(`
    Array [
      Object {
        "name": "FOOBAR",
        "valueFrom": Object {
          "secretKeyRef": Object {
            "key": "token",
            "name": "foobar-token",
          },
        },
      },
    ]
  `);
});

test("Should allow wildcards in cascadingRules", () => {
  sslyzeCascadingRules = [
    {
      apiVersion: "cascading.securecodebox.io/v1",
      kind: "CascadingRule",
      metadata: {
        name: "tls-scans"
      },
      spec: {
        matches: {
          anyOf: [
            {
              category: "Open Port",
              attributes: {
                port: 8443,
                service: "https*"
              }
            }
          ]
        },
        scanSpec: {
          scanType: "sslyze",
          parameters: ["--regular", "{{$.hostOrIP}}:{{attributes.port}}"]
        }
      }
    }
  ];

  const findings = [
    {
      name: "Port 8443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 8443,
        service: "https-alt"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  expect(cascadedScans).toMatchInlineSnapshot(`
    Array [
      Object {
        "apiVersion": "execution.securecodebox.io/v1",
        "kind": "Scan",
        "metadata": Object {
          "annotations": Object {
            "cascading.securecodebox.io/chain": "tls-scans",
            "cascading.securecodebox.io/matched-finding": undefined,
            "cascading.securecodebox.io/parent-scan": "nmap-foobar.com",
            "securecodebox.io/hook": "cascading-scans",
          },
          "generateName": "sslyze-foobar.com-tls-scans-",
          "labels": Object {},
          "ownerReferences": Array [
            Object {
              "apiVersion": "execution.securecodebox.io/v1",
              "blockOwnerDeletion": true,
              "controller": true,
              "kind": "Scan",
              "name": "nmap-foobar.com",
              "uid": undefined,
            },
          ],
        },
        "spec": Object {
          "cascades": Object {},
          "env": Array [],
          "parameters": Array [
            "--regular",
            "foobar.com:8443",
          ],
          "scanType": "sslyze",
          "volumeMounts": Array [],
          "volumes": Array [],
        },
      },
    ]
  `);
});

test("should not copy labels if inheritLabels is set to false", () => {
  parentScan.metadata.labels = {
    organization: "OWASP",
    location: "barcelona",
    vlan: "lan"
  };
  parentScan.spec.cascades.inheritLabels = false;

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  for (const cascadedScan of cascadedScans) {
    expect(Object.entries(parentScan.metadata.labels).every(([label, value]) =>
      cascadedScan.metadata.labels[label] === value
    )).toBe(false)
  }
});

test("should copy labels if inheritLabels is not set", () => {
  parentScan.metadata.labels = {
    organization: "OWASP",
    location: "barcelona",
    vlan: "lan"
  };

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  for (const cascadedScan of cascadedScans) {
    expect(Object.entries(parentScan.metadata.labels).every(([label, value]) =>
      cascadedScan.metadata.labels[label] === value
    )).toBe(true)
  }
});

test("should copy labels if inheritLabels is set to true", () => {
  parentScan.metadata.labels = {
    organization: "OWASP",
    location: "barcelona",
    vlan: "lan"
  };

  parentScan.spec.cascades.inheritLabels = true;

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  for (const cascadedScan of cascadedScans) {
    expect(Object.entries(parentScan.metadata.labels).every(([label, value]) =>
      cascadedScan.metadata.labels[label] === value
    )).toBe(true)
  }
});

test("should not copy annotations if inheritAnnotations is set to false", () => {
  parentScan.metadata.annotations = {
    "defectdojo.securecodebox.io/product-name": "barcelona-network-sca",
    "defectdojo.securecodebox.io/engagement-name": "scb-automated-scan"
  };
  parentScan.spec.cascades.inheritAnnotations = false;

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  for (const cascadedScan of cascadedScans) {
    expect(Object.entries(parentScan.metadata.annotations).every(([label, value]) =>
      cascadedScan.metadata.annotations[label] === value
    )).toBe(false)
  }
});

test("should copy annotations if inheritAnnotations is not set", () => {
  parentScan.metadata.annotations = {
    "defectdojo.securecodebox.io/product-name": "barcelona-network-sca",
    "defectdojo.securecodebox.io/engagement-name": "scb-automated-scan"
  };

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  for (const cascadedScan of cascadedScans) {
    expect(Object.entries(parentScan.metadata.annotations).every(([label, value]) =>
      cascadedScan.metadata.annotations[label] === value
    )).toBe(true)
  }
});

test("should copy annotations if inheritAnnotations is set to true", () => {
  parentScan.metadata.annotations = {
    "defectdojo.securecodebox.io/product-name": "barcelona-network-sca",
    "defectdojo.securecodebox.io/engagement-name": "scb-automated-scan"
  };
  parentScan.spec.cascades.inheritAnnotations = true;

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  for (const cascadedScan of cascadedScans) {
    expect(Object.entries(parentScan.metadata.annotations).every(([label, value]) =>
      cascadedScan.metadata.annotations[label] === value
    )).toBe(true)
  }
});

test("should copy scanLabels from CascadingRule to cascading scan", () => {
  sslyzeCascadingRules[0].spec.scanLabels = {
    k_one: "v_one",
    k_two: "v_two"
  }

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]
  expect(Object.entries(sslyzeCascadingRules[0].spec.scanLabels).every(([label, value]) =>
    cascadedScan.metadata.labels[label] === value
  )).toBe(true)
});

test("should copy scanAnnotations from CascadingRule to cascading scan", () => {
  sslyzeCascadingRules[0].spec.scanAnnotations = {
    k_one: "v_one",
    k_two: "v_two"
  }

  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]
  expect(Object.entries(sslyzeCascadingRules[0].spec.scanAnnotations).every(([label, value]) =>
    cascadedScan.metadata.annotations[label] === value
  )).toBe(true)
});

test("should properly parse template values in scanLabels and scanAnnotations", () => {
  sslyzeCascadingRules[0].spec.scanAnnotations = {
    k_one: "{{metadata.name}}",
    k_two: "{{metadata.unknown_property}}",
    k_three: "{{$.hostOrIP}}"
  }

  sslyzeCascadingRules[0].spec.scanLabels = {
    k_one: "{{metadata.name}}",
    k_two: "{{metadata.unknown_property}}",
    k_three: "{{$.hostOrIP}}"
  }

  const findings = [
    {
      name: "Port 8443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 8443,
        service: "https"
      }
    },
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules,
    sslyzeCascadingRules[0]
  );

  expect(sslyzeCascadingRules[0].spec.scanSpec.parameters).toEqual(["--regular", "{{$.hostOrIP}}:{{attributes.port}}"])

  const { labels, annotations } = cascadedScans[0].metadata;

  // No snapshots as scanLabels/scanAnnotations can be in any order
  const labelResults = {
    "k_one": "nmap-foobar.com",
    "k_two": "",
    "k_three": "foobar.com",
  }

  expect(labels).toEqual(labelResults)

  const annotationsResults = {
    "cascading.securecodebox.io/chain": "tls-scans",
    "cascading.securecodebox.io/matched-finding": undefined,
    "cascading.securecodebox.io/parent-scan": "nmap-foobar.com",
    "securecodebox.io/hook": "cascading-scans",
    "k_one": "nmap-foobar.com",
    "k_two": "",
    "k_three": "foobar.com",
  };

  expect(annotations).toEqual(annotationsResults)
})

test("should copy proper finding ID into annotations", () => {
  const findings = [
    {
      name: "Port 12345 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 12345,
        service: "unknown"
      },
      id: "random-id"
    },
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      },
      id: "f0c718bd-9987-42c8-2259-73794e61dd5a"
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]
  expect(Object.entries(cascadedScan.metadata.annotations).every(([label, value]) => {
    if (label === "cascading.securecodebox.io/matched-finding") {
      return value === "f0c718bd-9987-42c8-2259-73794e61dd5a";
    } else return true;
  }
  )).toBe(true)
});

test("should merge environment variables into cascaded scan", () => {
  parentScan.spec.cascades.inheritEnv = true
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  parentScan.spec.env = [
    {
      "name": "parent_environment_variable_name",
      "value": "parent_environment_variable_value"
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.env = [
    {
      "name": "rule_environment_variable_name",
      "value": "rule_environment_variable_value"
    }
  ]

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]
  expect(cascadedScan.spec.env).toMatchInlineSnapshot(`
    Array [
      Object {
        "name": "parent_environment_variable_name",
        "value": "parent_environment_variable_value",
      },
      Object {
        "name": "rule_environment_variable_name",
        "value": "rule_environment_variable_value",
      },
    ]
  `);
});

test("should merge volumeMounts into cascaded scan", () => {
  parentScan.spec.cascades.inheritVolumes = true
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  parentScan.spec.volumeMounts = [
    {
      "mountPath": "/etc/ssl/certs/ca-cert.cer",
      "name": "ca-certificate",
      "readOnly": true,
      "subPath": "ca-cert.cer"
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.volumeMounts = [
    {
      "mountPath": "/etc/ssl/certs/ca-cert-sslyze.cer",
      "name": "ca-certificate-sslyze",
      "readOnly": true,
      "subPath": "ca-cert-sslyze.cer"
    }
  ]

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]
  expect(cascadedScan.spec.volumeMounts).toMatchInlineSnapshot(`
    Array [
      Object {
        "mountPath": "/etc/ssl/certs/ca-cert.cer",
        "name": "ca-certificate",
        "readOnly": true,
        "subPath": "ca-cert.cer",
      },
      Object {
        "mountPath": "/etc/ssl/certs/ca-cert-sslyze.cer",
        "name": "ca-certificate-sslyze",
        "readOnly": true,
        "subPath": "ca-cert-sslyze.cer",
      },
    ]
  `);
});

test("should merge volumes into cascaded scan", () => {
  parentScan.spec.cascades.inheritVolumes = true
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  parentScan.spec.volumes = [
    {
      "name": "ca-certificate",
      "configMap": {
        "name": "ca-certificate"
      }
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.volumes = [
    {
      "name": "ca-certificate-sslyze",
      "configMap": {
        "name": "ca-certificate-sslyze"
      }
    }
  ]

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0];

  expect(cascadedScan.spec.volumes).toMatchInlineSnapshot(`
    Array [
      Object {
        "configMap": Object {
          "name": "ca-certificate",
        },
        "name": "ca-certificate",
      },
      Object {
        "configMap": Object {
          "name": "ca-certificate-sslyze",
        },
        "name": "ca-certificate-sslyze",
      },
    ]
  `);
});

test("should purge cascaded scan spec from parent scan", () => {
  parentScan.spec.cascades.inheritEnv = true
  parentScan.spec.cascades.inheritVolumes = true
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  parentScan.spec.volumes = [
    {
      "name": "ca-certificate",
      "configMap": {
        "name": "ca-certificate"
      }
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.volumes = [
    {
      "name": "ca-certificate-sslyze",
      "configMap": {
        "name": "ca-certificate-sslyze"
      }
    }
  ]

  parentScan.spec.volumeMounts = [
    {
      "mountPath": "/etc/ssl/certs/ca-cert.cer",
      "name": "ca-certificate",
      "readOnly": true,
      "subPath": "ca-cert.cer"
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.volumeMounts = [
    {
      "mountPath": "/etc/ssl/certs/ca-cert-sslyze.cer",
      "name": "ca-certificate-sslyze",
      "readOnly": true,
      "subPath": "ca-cert-sslyze.cer"
    }
  ]

  parentScan.spec.env = [
    {
      "name": "parent_environment_variable_name",
      "value": "parent_environment_variable_value"
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.env = [
    {
      "name": "rule_environment_variable_name",
      "value": "rule_environment_variable_value"
    }
  ]

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]

  // Create a second cascading rule
  sslyzeCascadingRules[1] = {
    apiVersion: "cascading.securecodebox.io/v1",
    kind: "CascadingRule",
    metadata: {
      name: "tls-scans-second"
    },
    spec: {
      matches: {
        anyOf: [
          {
            category: "Open Port",
            attributes: {
              port: 443,
              service: "https"
            }
          },
          {
            category: "Open Port",
            attributes: {
              service: "https"
            }
          }
        ]
      },
      scanSpec: {
        scanType: "sslyze",
        parameters: ["--regular", "{{$.hostOrIP}}:{{attributes.port}}"]
      }
    }
  }

  cascadedScan.metadata.name = cascadedScan.metadata.generateName

  const secondCascadedScans = getCascadingScans(
    cascadedScan,
    findings,
    sslyzeCascadingRules,
    sslyzeCascadingRules[0] // cascaded rule on parent
  );

  const secondCascadedScan = secondCascadedScans[0];

  expect(secondCascadedScan.spec.env).toMatchInlineSnapshot(`
    Array [
      Object {
        "name": "parent_environment_variable_name",
        "value": "parent_environment_variable_value",
      },
    ]
  `)

  expect(secondCascadedScan.spec.volumes).toMatchInlineSnapshot(`
    Array [
      Object {
        "configMap": Object {
          "name": "ca-certificate",
        },
        "name": "ca-certificate",
      },
    ]
  `)

  expect(secondCascadedScan.spec.volumeMounts).toMatchInlineSnapshot(`
    Array [
      Object {
        "mountPath": "/etc/ssl/certs/ca-cert.cer",
        "name": "ca-certificate",
        "readOnly": true,
        "subPath": "ca-cert.cer",
      },
    ]
  `)

});

test("should not copy cascaded scan spec from parent scan if inheritance is undefined", () => {
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  parentScan.spec.volumes = [
    {
      "name": "ca-certificate",
      "configMap": {
        "name": "ca-certificate"
      }
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.volumes = [
    {
      "name": "ca-certificate-sslyze",
      "configMap": {
        "name": "ca-certificate-sslyze"
      }
    }
  ]

  parentScan.spec.volumeMounts = [
    {
      "mountPath": "/etc/ssl/certs/ca-cert.cer",
      "name": "ca-certificate",
      "readOnly": true,
      "subPath": "ca-cert.cer"
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.volumeMounts = [
    {
      "mountPath": "/etc/ssl/certs/ca-cert-sslyze.cer",
      "name": "ca-certificate-sslyze",
      "readOnly": true,
      "subPath": "ca-cert-sslyze.cer"
    }
  ]

  parentScan.spec.env = [
    {
      "name": "parent_environment_variable_name",
      "value": "parent_environment_variable_value"
    }
  ]

  sslyzeCascadingRules[0].spec.scanSpec.env = [
    {
      "name": "rule_environment_variable_name",
      "value": "rule_environment_variable_value"
    }
  ]

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]
  // Create a second cascading rule
  sslyzeCascadingRules[1] = {
    apiVersion: "cascading.securecodebox.io/v1",
    kind: "CascadingRule",
    metadata: {
      name: "tls-scans-second"
    },
    spec: {
      matches: {
        anyOf: [
          {
            category: "Open Port",
            attributes: {
              port: 443,
              service: "https"
            }
          },
          {
            category: "Open Port",
            attributes: {
              service: "https"
            }
          }
        ]
      },
      scanSpec: {
        scanType: "sslyze",
        parameters: ["--regular", "{{$.hostOrIP}}:{{attributes.port}}"]
      }
    }
  }

  cascadedScan.metadata.name = cascadedScan.metadata.generateName

  const secondCascadedScans = getCascadingScans(
    cascadedScan,
    findings,
    sslyzeCascadingRules,
    sslyzeCascadingRules[0] // cascaded rule on parent
  );

  const secondCascadedScan = secondCascadedScans[0];

  expect(secondCascadedScan.spec.env).toMatchInlineSnapshot(`Array []`)

  expect(secondCascadedScan.spec.volumes).toMatchInlineSnapshot(`Array []`)

  expect(secondCascadedScan.spec.volumeMounts).toMatchInlineSnapshot(`Array []`)

});


test("should append cascading rule to further cascading scan chains", () => {
  const findings = [
    {
      name: "Port 443 is open",
      category: "Open Port",
      attributes: {
        state: "open",
        hostname: "foobar.com",
        port: 443,
        service: "https"
      }
    }
  ];

  const cascadedScans = getCascadingScans(
    parentScan,
    findings,
    sslyzeCascadingRules
  );

  const cascadedScan = cascadedScans[0]
  // Create a second cascading rule
  sslyzeCascadingRules[1] = {
    apiVersion: "cascading.securecodebox.io/v1",
    kind: "CascadingRule",
    metadata: {
      name: "tls-scans-second"
    },
    spec: {
      matches: {
        anyOf: [
          {
            category: "Open Port",
            attributes: {
              port: 443,
              service: "https"
            }
          },
          {
            category: "Open Port",
            attributes: {
              service: "https"
            }
          }
        ]
      },
      scanSpec: {
        scanType: "sslyze",
        parameters: ["--regular", "{{$.hostOrIP}}:{{attributes.port}}"]
      }
    }
  }

  cascadedScan.metadata.name = cascadedScan.metadata.generateName

  const secondCascadedScans = getCascadingScans(
    cascadedScan,
    findings,
    sslyzeCascadingRules,
    sslyzeCascadingRules[0] // cascaded rule on parent
  );

  const secondCascadedScan = secondCascadedScans[0];

  expect(secondCascadedScan.metadata.annotations["cascading.securecodebox.io/chain"]).toEqual("tls-scans,tls-scans-second")
});
