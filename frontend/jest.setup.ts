import '@testing-library/jest-dom';
import 'whatwg-fetch';
import { TextEncoder, TextDecoder } from 'util';
global.TextEncoder = TextEncoder as any;
global.TextDecoder = TextDecoder as any;
import { toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);
